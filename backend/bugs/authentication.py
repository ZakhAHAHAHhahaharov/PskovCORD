from rest_framework_simplejwt.authentication import JWTAuthentication


class OptionalJWTAuthentication(JWTAuthentication):
    """JWT, который при негодном токене не отвечает 401, а просто считает
    запрос анонимным.

    Нужен ровно одной ручке — приёму отчётов об ошибках (bugs.views).
    Обычная JWTAuthentication на просроченном/битом токене поднимает
    AuthenticationFailed ещё до проверки прав, то есть отчёт не дошёл бы
    именно в самой интересной ситуации: сессия развалилась, приложение сыплет
    ошибками — и ни одна из них до нас не доезжает. Здесь токен нужен не для
    доступа (ручка и так открыта), а только чтобы подписать отчёт ником, и
    ради подписи терять сам отчёт бессмысленно.
    """

    def authenticate(self, request):
        try:
            return super().authenticate(request)
        except Exception:
            return None
