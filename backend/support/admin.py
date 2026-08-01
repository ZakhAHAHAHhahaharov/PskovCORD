from django.contrib import admin
from django.urls import reverse
from django.utils.html import format_html, format_html_join

from .models import BugReport, ReportStatus


@admin.register(BugReport)
class BugReportAdmin(admin.ModelAdmin):
    list_display = (
        "created_at", "user_or_anon", "status_badge", "excerpt",
        "platform", "linked_errors_count",
    )
    list_filter = ("status", "platform", "created_at")
    search_fields = ("description", "steps", "user__username", "route", "app_version")
    date_hierarchy = "created_at"
    list_select_related = ("user",)
    filter_horizontal = ("related_groups",)
    actions = ["mark_in_progress", "mark_answered", "mark_closed"]
    readonly_fields = (
        "user", "description", "steps", "platform", "route",
        "user_agent", "app_version", "created_at", "linked_errors",
    )
    fieldsets = (
        ("Обращение", {
            "fields": ("created_at", "user", "description", "steps"),
        }),
        ("Разбор", {
            "fields": ("status", "admin_note", "linked_errors", "related_groups"),
        }),
        ("Откуда пришло", {
            "classes": ("collapse",),
            "fields": ("platform", "route", "app_version", "user_agent"),
        }),
    )

    @admin.display(description="Автор", ordering="user__username")
    def user_or_anon(self, obj):
        return obj.user.username if obj.user else "— аноним —"

    @admin.display(description="Статус", ordering="status")
    def status_badge(self, obj):
        colors = {
            ReportStatus.NEW: "#d93025",
            ReportStatus.IN_PROGRESS: "#e37400",
            ReportStatus.ANSWERED: "#188038",
            ReportStatus.CLOSED: "#80868b",
        }
        return format_html(
            '<b style="color:{}">{}</b>',
            colors.get(obj.status, "#000"), obj.get_status_display())

    @admin.display(description="Суть")
    def excerpt(self, obj):
        text = obj.description.strip().replace("\n", " ")
        return text[:80] + "…" if len(text) > 80 else text

    @admin.display(description="Ошибок")
    def linked_errors_count(self, obj):
        return obj.related_groups.count()

    @admin.display(description="Ошибки, случившиеся перед обращением")
    def linked_errors(self, obj):
        """Ради этого блока всё и делалось: «у меня не работает» само по себе
        не чинится, а рядом со стектрейсом минутной давности — это готовый
        тикет."""
        groups = obj.related_groups.all()
        if not groups:
            return format_html(
                '<i style="color:#898781">Ошибок в этот момент не поймано — '
                'либо всё сломалось молча, либо дело не в исключении.</i>')
        return format_html(
            "<ul style='margin:0;padding-left:18px'>{}</ul>",
            format_html_join(
                "", "<li><a href='{}'>{}</a> — {}, событий: {}</li>",
                (
                    (
                        reverse("admin:bugs_errorgroup_change", args=[g.pk]),
                        g.title,
                        g.get_kind_display(),
                        g.times_seen,
                    )
                    for g in groups
                ),
            ),
        )

    def has_add_permission(self, request):
        # Обращения приходят только из формы — заводить их руками бессмысленно.
        return False

    def _set_status(self, request, queryset, status):
        updated = queryset.update(status=status)
        self.message_user(request, f"Обновлено обращений: {updated}.")

    @admin.action(description="Пометить «В работе»")
    def mark_in_progress(self, request, queryset):
        self._set_status(request, queryset, ReportStatus.IN_PROGRESS)

    @admin.action(description="Пометить «Отвечено»")
    def mark_answered(self, request, queryset):
        self._set_status(request, queryset, ReportStatus.ANSWERED)

    @admin.action(description="Пометить «Закрыто»")
    def mark_closed(self, request, queryset):
        self._set_status(request, queryset, ReportStatus.CLOSED)
