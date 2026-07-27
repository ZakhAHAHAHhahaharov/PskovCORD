import uuid

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import login as django_login, logout as django_logout
from django.utils import timezone
from rest_framework import generics, permissions
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .models import LoginSession
from .serializers import (
    ChangePasswordSerializer,
    MeSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
)


def _broadcast_profile_update(user):
    """Живое обновление ника/аватара у остальных — на всех серверах, где
    состоит пользователь (тот же паттерн group_send, что и channel_create/
    voice_state_update в chat.views/consumers). Импорт Membership — внутри
    функции: chat не импортируется на уровне модуля accounts, чтобы не
    создавать лишнюю связь между приложениями при обычной загрузке Django."""
    from chat.models import Membership

    server_ids = Membership.objects.filter(user=user).values_list(
        "server_id", flat=True)
    payload = {
        "op": "profile_update",
        "user_id": user.id,
        "username": user.username,
        "avatar_color": user.avatar_color,
        "avatar_image": user.avatar_image,
    }
    channel_layer = get_channel_layer()
    for server_id in server_ids:
        async_to_sync(channel_layer.group_send)(
            f"server_{server_id}", {"type": "broadcast", "payload": payload})


def get_client_ip(request):
    """IP клиента с учётом nginx перед бэкендом (тот же приём доверия
    заголовкам прокси, что и для X-Forwarded-Proto — см. SECURE_PROXY_SSL_HEADER
    в settings.py). REMOTE_ADDR за прокси был бы просто адресом nginx."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


class SessionTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Добавляет в токен claim session_id — случайный uuid, который
    выставляется один раз при логине и переживает ротацию refresh-токена как
    есть (SimpleJWT при ROTATE_REFRESH_TOKENS переиспользует тот же объект
    токена, просто сбрасывая jti/iat/exp — остальные claims остаются). Он и
    есть идентификатор "сеанса" для LoginSession/«Активные сеансы» — jti сам
    по себе для этого не годится, он меняется на каждый /token/refresh."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["session_id"] = str(uuid.uuid4())
        return token


def tokens_for(user):
    refresh = SessionTokenObtainPairSerializer.get_token(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


def record_login_session(user, refresh_str, request):
    """Завести строку LoginSession для новеньких (только что выданных при
    логине/регистрации) access/refresh — см. SessionTokenObtainPairSerializer.
    Обновление той же строки при последующих /token/refresh — в
    SessionTokenRefreshView, по тому же session_id."""
    token = RefreshToken(refresh_str)
    LoginSession.objects.create(
        user=user,
        session_id=token["session_id"],
        jti=token["jti"],
        ip_address=get_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", "")[:300],
    )


def revoke_all_refresh_tokens(user):
    """Отозвать все выданные пользователю refresh-токены.

    Нужно при смене пароля: его меняют в том числе тогда, когда он утёк, и
    остальные сессии обязаны умереть. Access-токены так не отозвать — они
    проверяются по подписи, без похода в БД, — но их срок теперь 15 минут
    (см. settings.SIMPLE_JWT), это и есть верхняя граница окна.
    """
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)
    # «Активные сеансы» должны опустеть вместе с самими сессиями — иначе
    # список ещё показывал бы устройства, токены которых уже отозваны выше.
    LoginSession.objects.filter(user=user).delete()


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]
    # Отдельная жёсткая шкала для auth-ручек (10/min, см. settings) — без неё
    # подбор пароля ограничивался только шириной канала.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        # Заодно заводим обычную Django-сессию (cookie) — тем же логином,
        # что и в приложении, пускает и в /adminpskordpro/ без отдельного
        # входа (см. LoginView.post — тот же приём).
        django_login(request, user)
        tokens = tokens_for(user)
        record_login_session(user, tokens["refresh"], request)
        return Response(
            {"user": MeSerializer(user).data, **tokens},
            status=201,
        )


class LoginView(TokenObtainPairView):
    """Как стоковый TokenObtainPairView (те же access/refresh в ответе), но
    дополнительно логинит через django.contrib.auth — ставит session-cookie,
    поэтому staff-пользователи сразу попадают в /adminpskordpro/ тем же
    логином/паролем, без отдельного входа в админку."""

    serializer_class = SessionTokenObtainPairSerializer
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        django_login(request, serializer.user)
        record_login_session(
            serializer.user, serializer.validated_data["refresh"], request)
        return Response(serializer.validated_data, status=200)


class SessionTokenRefreshView(TokenRefreshView):
    """Стоковый TokenRefreshView, только заодно двигает LoginSession той же
    "сессии" (session_id claim) на новый jti — иначе «Активные сеансы» после
    первого же обновления токена не находили бы для неё живой
    OutstandingToken (см. SessionListView) и сеанс пропадал бы из списка
    сразу после логина."""

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        refresh_str = response.data.get("refresh") if response.status_code == 200 else None
        if refresh_str:
            try:
                token = RefreshToken(refresh_str)
            except TokenError:
                return response
            # payload.get(), а не token['session_id']: токены, выданные ДО
            # появления этого claim, его не несут — не хотим падать на них,
            # просто не обновляем LoginSession (сеанс истечёт сам по себе).
            session_id = token.payload.get("session_id")
            if session_id:
                LoginSession.objects.filter(session_id=session_id).update(
                    jti=token["jti"],
                    ip_address=get_client_ip(request),
                    user_agent=request.META.get("HTTP_USER_AGENT", "")[:300],
                    last_seen_at=timezone.now(),
                )
        return response


class LogoutView(APIView):
    """Гасит Django-сессию (см. LoginView) при выходе из приложения — иначе
    после логаута в SPA сессия в админке молча жила бы своим сроком — и
    отзывает refresh-токен, если клиент его прислал."""

    def post(self, request):
        # Раньше выход не отзывал вообще ничего: refresh жил ещё неделю,
        # access — сутки. Теперь refresh уезжает в блэклист, а короткий срок
        # access'а (15 минут) ограничивает остаток окна.
        refresh = request.data.get("refresh")
        if refresh:
            try:
                token = RefreshToken(refresh)
                session_id = token.payload.get("session_id")
                if session_id:
                    LoginSession.objects.filter(session_id=session_id).delete()
                token.blacklist()
            except TokenError:
                # Уже протух или отозван — для выхода это всё равно успех.
                pass
        django_logout(request)
        return Response(status=204)


class MeView(APIView):
    def get(self, request):
        return Response(MeSerializer(request.user).data)

    def patch(self, request):
        serializer = ProfileUpdateSerializer(
            request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        _broadcast_profile_update(user)
        return Response(MeSerializer(user).data)


class SessionListView(APIView):
    """«Активные сеансы» в настройках — с каких устройств/IP сейчас можно
    зайти под этим аккаунтом.

    Живость сеанса определяется ПО САМОЙ LoginSession (last_seen_at не
    старше REFRESH_TOKEN_LIFETIME), а не по OutstandingToken — при
    ROTATE_REFRESH_TOKENS SimpleJWT не заводит новую строку OutstandingToken
    на каждую ротацию, он переиспользует единственную строку первого
    выданного токена лишь для того, чтобы её можно было блэклистнуть; jti
    уже провёрнутого (ротированного) токена там не появляется вовсе, хотя
    сам токен остаётся действительным по подписи. Строка LoginSession
    удаляется явно — при logout и при смене пароля (revoke_all_refresh_tokens) —
    так что её наличие само по себе и есть признак «сеанс ещё не завершён»."""

    def get(self, request):
        cutoff = timezone.now() - settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]
        current_session_id = None
        auth = getattr(request, "auth", None)
        if auth is not None:
            current_session_id = auth.payload.get("session_id")

        sessions = LoginSession.objects.filter(
            user=request.user, last_seen_at__gte=cutoff,
        ).order_by("-last_seen_at")
        data = [
            {
                "id": s.id,
                "ip_address": s.ip_address,
                "user_agent": s.user_agent,
                "created_at": s.created_at,
                "last_seen_at": s.last_seen_at,
                "is_current": str(s.session_id) == str(current_session_id),
            }
            for s in sessions
        ]
        return Response(data)


class ChangePasswordView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        serializer = ChangePasswordSerializer(
            data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        request.user.set_password(serializer.validated_data["new_password"])
        request.user.save(update_fields=["password"])
        # Смена пароля должна выкидывать остальные сессии — иначе смена
        # пароля после утечки ничего не давала: старые токены продолжали
        # работать весь свой срок.
        revoke_all_refresh_tokens(request.user)
        return Response(status=204)
