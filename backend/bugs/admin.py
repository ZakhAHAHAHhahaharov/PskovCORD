from django.contrib import admin, messages
from django.db.models import Count
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone
from django.utils.html import format_html

from .models import ErrorEvent, ErrorGroup, ErrorKind, GroupStatus, Platform
from .views import summary_stats


class ErrorEventInline(admin.TabularInline):
    """Последние попадания прямо в карточке группы — обычно именно их и
    открывают: «кто именно словил и на каком экране». Полный список
    (с фильтрами и поиском) живёт в своём разделе «События ошибок»."""

    model = ErrorEvent
    extra = 0
    can_delete = False
    max_num = 0  # только просмотр: события создаёт клиент, не человек
    fields = ("created_at", "user", "platform", "route", "app_version")
    readonly_fields = fields
    ordering = ("-created_at",)

    def get_queryset(self, request):
        # Группа может насчитывать десятки тысяч событий — без среза страница
        # карточки просто не откроется.
        qs = super().get_queryset(request).select_related("user")
        newest = qs.order_by("-created_at").values_list("pk", flat=True)[:20]
        return qs.filter(pk__in=list(newest))

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(ErrorGroup)
class ErrorGroupAdmin(admin.ModelAdmin):
    change_list_template = "admin/bugs/errorgroup/change_list.html"
    list_display = (
        "title_short", "kind_badge", "status_badge", "times_seen",
        "affected_users", "last_seen",
    )
    list_filter = ("status", "kind", "last_seen")
    search_fields = ("title", "culprit", "fingerprint")
    readonly_fields = (
        "fingerprint", "title", "culprit", "kind",
        "times_seen", "first_seen", "last_seen", "resolved_at",
    )
    fields = (
        "title", "kind", "culprit", "status",
        "times_seen", "first_seen", "last_seen", "resolved_at", "fingerprint",
    )
    inlines = [ErrorEventInline]
    actions = ["mark_resolved", "mark_investigating", "mark_ignored"]
    date_hierarchy = "last_seen"

    def get_queryset(self, request):
        # Число затронутых людей — не поле, а DISTINCT-подсчёт по событиям
        # (см. комментарий в модели о том, почему оно не денормализовано).
        return super().get_queryset(request).annotate(
            _affected=Count("events__user", distinct=True))

    @admin.display(description="Ошибка", ordering="title")
    def title_short(self, obj):
        text = obj.title if len(obj.title) <= 90 else obj.title[:90] + "…"
        if obj.is_regressed:
            # Регрессия — исправленная группа, которая стрельнула снова.
            # Без пометки она выглядит закрытой и теряется в списке.
            return format_html(
                '<span title="Вернулась после пометки «Исправлена»">🔁 {}</span>', text)
        return text

    @admin.display(description="Тип", ordering="kind")
    def kind_badge(self, obj):
        return obj.get_kind_display()

    @admin.display(description="Статус", ordering="status")
    def status_badge(self, obj):
        colors = {
            GroupStatus.NEW: "#d93025",
            GroupStatus.INVESTIGATING: "#e37400",
            GroupStatus.RESOLVED: "#188038",
            GroupStatus.IGNORED: "#80868b",
        }
        return format_html(
            '<b style="color:{}">{}</b>',
            colors.get(obj.status, "#000"), obj.get_status_display())

    @admin.display(description="Людей задето", ordering="_affected")
    def affected_users(self, obj):
        return obj._affected

    def has_add_permission(self, request):
        # Группы заводит только приём отчётов — руками создать её бессмысленно
        # (fingerprint всё равно не совпадёт ни с чем реальным).
        return False

    def _set_status(self, request, queryset, status):
        # resolved_at ставим только при переходе В «исправлена»: по нему потом
        # ловится регрессия (событие позже отметки), и обновлять его на
        # каждый чих значило бы стирать эту точку отсчёта.
        updated = queryset.update(
            status=status,
            resolved_at=timezone.now() if status == GroupStatus.RESOLVED else None,
        )
        self.message_user(request, f"Обновлено групп: {updated}.", messages.SUCCESS)

    @admin.action(description="Пометить «Исправлена»")
    def mark_resolved(self, request, queryset):
        self._set_status(request, queryset, GroupStatus.RESOLVED)

    @admin.action(description="Пометить «Разбираемся»")
    def mark_investigating(self, request, queryset):
        self._set_status(request, queryset, GroupStatus.INVESTIGATING)

    @admin.action(description="Пометить «Игнорируем»")
    def mark_ignored(self, request, queryset):
        self._set_status(request, queryset, GroupStatus.IGNORED)

    def save_model(self, request, obj, form, change):
        # То же правило, что и в bulk-действии выше, но для правки одной
        # карточки: иначе статус «Исправлена», выставленный руками, оставался
        # бы без даты и регрессия по нему не ловилась.
        if "status" in form.changed_data:
            obj.resolved_at = (
                timezone.now() if obj.status == GroupStatus.RESOLVED else None)
        super().save_model(request, obj, form, change)

    def get_urls(self):
        urls = super().get_urls()
        custom = [
            path(
                "dashboard/",
                self.admin_site.admin_view(self.dashboard_view),
                name="bugs_errorgroup_dashboard",
            ),
        ]
        # Свои маршруты — ПЕРЕД стандартными: у ModelAdmin последним идёт
        # catch-all <path:object_id>/, и «dashboard» уехал бы в него как id.
        return custom + urls

    def dashboard_view(self, request):
        try:
            days = max(1, min(int(request.GET.get("days", 14)), 90))
        except (TypeError, ValueError):
            days = 14
        stats = summary_stats(days)

        platform_labels = dict(Platform.choices)
        kind_labels = dict(ErrorKind.choices)
        charts = {
            "byDay": {
                "labels": [row["day"].strftime("%d.%m") for row in stats["by_day"]],
                "values": [row["count"] for row in stats["by_day"]],
            },
            "byPlatform": {
                "labels": [
                    platform_labels.get(row["platform"], row["platform"])
                    for row in stats["by_platform"]
                ],
                "values": [row["count"] for row in stats["by_platform"]],
            },
            "byKind": {
                "labels": [
                    kind_labels.get(row["group__kind"], row["group__kind"])
                    for row in stats["by_kind"]
                ],
                "values": [row["count"] for row in stats["by_kind"]],
            },
            "topGroups": {
                "labels": [
                    (g.title[:40] + "…") if len(g.title) > 40 else g.title
                    for g in stats["top_groups"]
                ],
                "values": [g.affected for g in stats["top_groups"]],
                "urls": [
                    reverse("admin:bugs_errorgroup_change", args=[g.pk])
                    for g in stats["top_groups"]
                ],
            },
        }
        context = {
            **self.admin_site.each_context(request),
            "title": "Сводка по ошибкам",
            "opts": self.model._meta,
            "stats": stats,
            # Через json_script в шаблоне — он экранирует данные сам; ручной
            # json.dumps в <script> ломается на любом апострофе в заголовке
            # ошибки (а он там сплошь и рядом: «Cannot read 'x'»).
            "charts": charts,
            "day_options": (7, 14, 30, 90),
        }
        return TemplateResponse(request, "admin/bugs/dashboard.html", context)


@admin.register(ErrorEvent)
class ErrorEventAdmin(admin.ModelAdmin):
    """Сырые попадания. Отдельный раздел нужен, чтобы искать по человеку
    («на что жалуется вот этот») и по экрану — из карточки группы такой
    срез не сделать."""

    list_display = ("created_at", "user", "platform", "group_title", "route")
    list_filter = ("platform", "group__kind", "created_at")
    search_fields = ("user__username", "message", "route", "app_version")
    readonly_fields = (
        "group", "user", "platform", "message", "stack", "route",
        "user_agent", "app_version", "created_at",
    )
    date_hierarchy = "created_at"
    list_select_related = ("user", "group")

    @admin.display(description="Ошибка", ordering="group__title")
    def group_title(self, obj):
        return format_html(
            '<a href="{}">{}</a>',
            reverse("admin:bugs_errorgroup_change", args=[obj.group_id]),
            obj.group.title[:70],
        )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        # Только чтение: событие — это факт с клиента, редактировать его
        # означало бы врать самим себе в аналитике.
        return False
