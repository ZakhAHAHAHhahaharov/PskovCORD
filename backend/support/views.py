from bugs import fingerprint, scrub
from bugs.authentication import OptionalJWTAuthentication
from bugs.models import ErrorGroup, ErrorKind, Platform
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from .models import MAX_DESCRIPTION, MAX_STEPS, BugReport

# Сколько последних ошибок клиента разбираем. Больше не нужно: связь ищется
# среди того, что случилось у человека непосредственно перед жалобой, а не
# за всю сессию.
MAX_LINKED_ERRORS = 10


class BugReportCreate(APIView):
    """POST /api/bug-reports — обращение из формы в правом нижнем углу.

    Открыто анонимам по той же причине, что и приём ошибок: человек, у
    которого не выходит войти, пожаловаться из-под входа не сможет, а это как
    раз тот, кому помощь нужнее всего. Троттл здесь заметно жёстче — форму
    заполняют руками, десятки отправок в минуту означают не пользователя.
    """

    authentication_classes = [OptionalJWTAuthentication]
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "support"

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}

        description = scrub.scrub(
            str(data.get("description") or "").strip(), MAX_DESCRIPTION)
        if not description:
            return Response(
                {"detail": "Опишите, что произошло."}, status=400)

        steps = scrub.scrub(str(data.get("steps") or "").strip(), MAX_STEPS)
        platform = data.get("platform")
        if platform not in Platform.values:
            platform = Platform.UNKNOWN

        report = BugReport.objects.create(
            user=request.user if request.user.is_authenticated else None,
            description=description,
            steps=steps,
            platform=platform,
            route=scrub.scrub_route(str(data.get("route") or "")),
            user_agent=scrub.scrub(request.META.get("HTTP_USER_AGENT", ""), 400),
            app_version=scrub.scrub(str(data.get("app_version") or ""), 60),
        )

        groups = self._match_groups(data.get("recent_errors"))
        if groups:
            report.related_groups.set(groups)

        # Единственная ручка из этих двух, которая отвечает телом: человек
        # нажал кнопку и ждёт подтверждения, что его услышали, — в отличие от
        # автоотчёта, который уходит молча.
        return Response({"id": report.id}, status=201)

    def _match_groups(self, recent):
        """Свести присланные клиентом последние ошибки с УЖЕ известными
        группами.

        Считаем подпись тем же кодом, что и приём отчётов, — иначе связь
        находилась бы через раз, по совпадению текста. Новых групп не
        заводим осознанно (см. комментарий у BugReport.related_groups).
        """
        if not isinstance(recent, list):
            return []
        digests = []
        for item in recent[:MAX_LINKED_ERRORS]:
            if not isinstance(item, dict):
                continue
            message = scrub.scrub(str(item.get("message") or "").strip(), 2000)
            if not message:
                continue
            kind = item.get("kind")
            if kind not in ErrorKind.values:
                kind = ErrorKind.JS_RUNTIME
            stack = scrub.scrub(str(item.get("stack") or ""), 8000)
            digests.append(fingerprint.compute(kind, message, stack))
        if not digests:
            return []
        return list(ErrorGroup.objects.filter(fingerprint__in=digests))
