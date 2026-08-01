from datetime import timedelta

from django.db.models import Count, F
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from . import fingerprint, scrub
from .authentication import OptionalJWTAuthentication
from .models import ErrorEvent, ErrorGroup, ErrorKind, GroupStatus, Platform

# Верхние границы полей. Нужны не для красоты: сюда приходит сырой текст с
# клиента, и стек уехавшего в рекурсию React'а — это мегабайты одинаковых
# кадров, которые незачем ни передавать, ни хранить.
MAX_MESSAGE = 2000
MAX_STACK = 8000


class ErrorIngest(APIView):
    """POST /api/errors — приём одного отчёта об ошибке с клиента.

    Открыт анонимам осознанно: половина по-настоящему обидных поломок живёт
    на экране входа и регистрации, то есть до появления пользователя, и
    закрыв ручку авторизацией, мы потеряли бы ровно тот класс ошибок, про
    который никто никогда не напишет в поддержку. Плата за это — свой
    жёсткий троттл (scope "errors") и вычистка секретов на входе (scrub.py).

    Отвечает 204 без тела: клиенту отсюда ничего не нужно, а любой ответ,
    который он попробует разобрать, — это шанс уронить его повторно уже
    внутри обработчика ошибок.
    """

    # Не штатная JWTAuthentication: та на просроченном токене отвечает 401 и
    # отчёт теряется — см. OptionalJWTAuthentication.
    authentication_classes = [OptionalJWTAuthentication]
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "errors"

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}

        message = scrub.scrub(str(data.get("message") or "").strip(), MAX_MESSAGE)
        if not message:
            # Пустое сообщение — ошибка ни о чём: сгруппировать её не по чему,
            # а в админке она будет только мешать.
            return Response({"detail": "message обязателен."}, status=400)

        kind = data.get("kind")
        if kind not in ErrorKind.values:
            kind = ErrorKind.JS_RUNTIME
        platform = data.get("platform")
        if platform not in Platform.values:
            platform = Platform.UNKNOWN

        stack = scrub.scrub(str(data.get("stack") or ""), MAX_STACK)
        route = scrub.scrub_route(str(data.get("route") or ""))
        app_version = scrub.scrub(str(data.get("app_version") or ""), 60)

        digest = fingerprint.compute(kind, message, stack)
        group, created = ErrorGroup.objects.get_or_create(
            fingerprint=digest,
            defaults={
                "kind": kind,
                "title": fingerprint.title_for(message),
                "culprit": fingerprint.top_frame(stack),
                "times_seen": 1,
            },
        )
        if not created:
            # F() и update() вместо чтения-изменения-записи: события одной
            # группы прилетают пачками и параллельно, и обычный
            # group.times_seen += 1 терял бы часть инкрементов на гонке.
            # last_seen с auto_now тут не сработает — его ставит save(),
            # которого при update() нет, поэтому время проставляем руками.
            ErrorGroup.objects.filter(pk=group.pk).update(
                times_seen=F("times_seen") + 1, last_seen=timezone.now())

        ErrorEvent.objects.create(
            group=group,
            user=request.user if request.user.is_authenticated else None,
            platform=platform,
            message=message,
            stack=stack,
            route=route,
            user_agent=scrub.scrub(request.META.get("HTTP_USER_AGENT", ""), 400),
            app_version=app_version,
        )
        return Response(status=204)


def summary_stats(days: int = 14):
    """Данные для сводки в админке (см. bugs.admin.ErrorGroupAdmin.dashboard).

    Живёт во views, а не в admin.py, чтобы считаться и в тестах, и — когда
    понадобится — в возможной будущей ручке для внешнего дашборда, без
    затаскивания туда админского реквеста.
    """
    since = timezone.now() - timedelta(days=days)
    events = ErrorEvent.objects.filter(created_at__gte=since)

    by_day = list(
        events.annotate(day=TruncDate("created_at"))
        .values("day")
        .annotate(count=Count("id"))
        .order_by("day")
    )
    by_platform = list(
        events.values("platform").annotate(count=Count("id")).order_by("-count")
    )
    by_kind = list(
        events.values("group__kind").annotate(count=Count("id")).order_by("-count")
    )
    top_groups = list(
        ErrorGroup.objects.filter(last_seen__gte=since)
        .exclude(status=GroupStatus.IGNORED)
        .annotate(affected=Count("events__user", distinct=True))
        .order_by("-affected", "-times_seen")[:10]
    )
    # Регрессии — «исправленные» группы, у которых событие пришло уже после
    # отметки о починке. Их видно только так: сама по себе такая группа
    # выглядит закрытой и в общем списке не всплывает.
    regressed = list(
        ErrorGroup.objects.filter(
            status=GroupStatus.RESOLVED,
            resolved_at__isnull=False,
            last_seen__gt=F("resolved_at"),
        ).order_by("-last_seen")[:10]
    )
    return {
        "days": days,
        "since": since,
        "total_events": events.count(),
        "total_groups": ErrorGroup.objects.filter(last_seen__gte=since).count(),
        "affected_users": events.exclude(user=None).values("user").distinct().count(),
        "by_day": by_day,
        "by_platform": by_platform,
        "by_kind": by_kind,
        "top_groups": top_groups,
        "regressed": regressed,
    }
