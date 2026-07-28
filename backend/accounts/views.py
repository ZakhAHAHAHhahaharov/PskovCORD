import random
import secrets
import uuid
from datetime import timedelta

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

from .models import LoginSession, QRLoginRequest
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


def record_login_session(user, refresh_str, ip_address, user_agent):
    """Завести строку LoginSession для новеньких (только что выданных при
    логине/регистрации/QR-подтверждении) access/refresh — см.
    SessionTokenObtainPairSerializer. Обновление той же строки при
    последующих /token/refresh — в SessionTokenRefreshView, по тому же
    session_id.

    ip_address/user_agent — явные параметры, а не request: при QR-логине
    request, которым подтверждают вход (телефон), и устройство, для
    которого заводится сессия (ПК, показавший QR), — два разных физических
    устройства. Извлекать их из "текущего" request было бы неверно для
    этого случая (см. QRConfirmView — там передаётся ip/UA, сохранённые в
    QRLoginRequest при /qr/start)."""
    token = RefreshToken(refresh_str)
    LoginSession.objects.create(
        user=user,
        session_id=token["session_id"],
        jti=token["jti"],
        ip_address=ip_address,
        user_agent=(user_agent or "")[:300],
    )


def blacklist_session(session):
    """Отозвать ИМЕННО ТЕКУЩИЙ refresh-токен сеанса (session.jti) и удалить
    саму строку LoginSession.

    OutstandingToken для этого jti почти наверняка ещё не существует: строка
    заводится SimpleJWT только в момент выдачи самого первого токена сессии
    (see RefreshToken.for_user) и заново — в момент блэклиста ПРЕДЫДУЩЕГО jti
    при очередной ротации (see TokenRefreshSerializer.validate: blacklist()
    вызывается для СТАРОГО jti, до set_jti() на новый). Иначе говоря, у
    текущего (ещё ни разу не ротированного) jti активной сессии просто нет
    своей строки — get_or_create заводит её здесь же, специально чтобы было
    что блэклистить.
    """
    token, _ = OutstandingToken.objects.get_or_create(
        jti=session.jti,
        defaults={
            "user": session.user,
            "token": "",
            "created_at": timezone.now(),
            "expires_at": timezone.now() + settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"],
        },
    )
    BlacklistedToken.objects.get_or_create(token=token)
    session.delete()


def revoke_all_refresh_tokens(user):
    """Отозвать все выданные пользователю refresh-токены.

    Нужно при смене пароля (его меняют в том числе тогда, когда он утёк, и
    остальные сессии обязаны умереть) и при явном «Выйти на всех
    устройствах». Access-токены так не отозвать — они проверяются по
    подписи, без похода в БД, — но их срок теперь 15 минут (см.
    settings.SIMPLE_JWT), это и есть верхняя граница окна.
    """
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)
    # Дырка, которую легко не заметить: цикл выше блэклистит только jti,
    # которые УЖЕ засветились в OutstandingToken (первый токен сессии и все,
    # что были отозваны предыдущими ротациями) — ТЕКУЩИЙ, ещё ни разу не
    # ротированный jti каждой сессии там не появится (см. blacklist_session).
    # Без этого шага сеанс, который хоть раз обновлялся (а обновляются все —
    # access живёт 15 минут), пережил бы «отозвать всё» на своём текущем
    # refresh-токене.
    for session in LoginSession.objects.filter(user=user):
        blacklist_session(session)


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
        record_login_session(
            user, tokens["refresh"], get_client_ip(request),
            request.META.get("HTTP_USER_AGENT", ""))
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
            serializer.user, serializer.validated_data["refresh"],
            get_client_ip(request), request.META.get("HTTP_USER_AGENT", ""))
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


def _current_session_id(request) -> str | None:
    auth = getattr(request, "auth", None)
    return auth.payload.get("session_id") if auth is not None else None


def _serialize_session(session, current_session_id) -> dict:
    return {
        "id": session.id,
        "ip_address": session.ip_address,
        "user_agent": session.user_agent,
        "created_at": session.created_at,
        "last_seen_at": session.last_seen_at,
        "is_current": str(session.session_id) == str(current_session_id),
    }


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
    удаляется явно — при logout, отзыве конкретного сеанса и смене пароля /
    «выйти на всех устройствах» (revoke_all_refresh_tokens/blacklist_session) —
    так что её наличие само по себе и есть признак «сеанс ещё не завершён»."""

    def get(self, request):
        cutoff = timezone.now() - settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]
        current_session_id = _current_session_id(request)
        sessions = LoginSession.objects.filter(
            user=request.user, last_seen_at__gte=cutoff,
        ).order_by("-last_seen_at")
        return Response([_serialize_session(s, current_session_id) for s in sessions])


class SessionDetailView(APIView):
    """Отозвать ОДИН сеанс — крестик у "других устройств" в настройках.
    Нельзя отозвать текущий отсюда (это делает обычный logout, у него другая
    семантика — гасит и Django-сессию), поэтому 400, а не молчаливый no-op."""

    def delete(self, request, pk):
        try:
            session = LoginSession.objects.get(id=pk, user=request.user)
        except LoginSession.DoesNotExist:
            return Response(status=404)
        if str(session.session_id) == str(_current_session_id(request)):
            return Response(
                {"detail": "Текущий сеанс отзывается через обычный выход."},
                status=400,
            )
        blacklist_session(session)
        return Response(status=204)


class SessionRevokeAllView(APIView):
    """«Выйти на всех известных устройствах» — в отличие от смены пароля, сам
    пароль не трогает, только отзывает refresh-токены (см.
    revoke_all_refresh_tokens). Текущий access ещё доработает свои
    оставшиеся минуты (см. SIMPLE_JWT.ACCESS_TOKEN_LIFETIME), но обновить
    его сессии больше не смогут — как и было явно обещано в UI."""

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        revoke_all_refresh_tokens(request.user)
        return Response(status=204)


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


# --- вход по QR-коду -----------------------------------------------------
# Ссылка на "ждёт сканирования, ждёт подтверждения" — короче TTL refresh-
# токена в разы, окно атаки на угаданный/перехваченный token минимально.
QR_LOGIN_TTL = timedelta(minutes=2)


def _generate_qr_code_candidates():
    """Верный 2-значный код + ещё 3 отличных от него — то, что телефон
    покажет для выбора. Не про защиту от подбора (это делает сам token,
    длинный и случайный) — про то, чтобы человек сверил глазами один и тот
    же код на обоих экранах перед подтверждением (см. QRLoginRequest)."""
    correct = f"{secrets.randbelow(100):02d}"
    candidates = {correct}
    while len(candidates) < 4:
        candidates.add(f"{secrets.randbelow(100):02d}")
    candidates = list(candidates)
    random.shuffle(candidates)
    return correct, candidates


class QRStartView(APIView):
    """Страница логина на ПК — заводит запрос и получает token для QR.
    Без авторизации: это и есть первый шаг для ещё не залогиненного ПК."""

    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        # Опportунистическая чистка — без периодического sweep'а строки
        # копились бы вечно. Дёшево при ожидаемом объёме (эта ручка сама по
        # себе троттлится).
        QRLoginRequest.objects.filter(
            created_at__lt=timezone.now() - QR_LOGIN_TTL).delete()
        qr = QRLoginRequest.objects.create(
            token=secrets.token_urlsafe(32),
            ip_address=get_client_ip(request),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:300],
        )
        return Response({
            "token": qr.token,
            "expires_in": int(QR_LOGIN_TTL.total_seconds()),
        }, status=201)


def _get_live_qr(token):
    """QRLoginRequest по token'у, либо None если не найден/истёк (и тогда
    же подчищен)."""
    try:
        qr = QRLoginRequest.objects.get(token=token)
    except QRLoginRequest.DoesNotExist:
        return None
    if qr.created_at < timezone.now() - QR_LOGIN_TTL:
        qr.delete()
        return None
    return qr


class QRStatusView(APIView):
    """Поллинг с ПК — без авторизации, тем же самым token'ом, которым он сам
    себя и представляет (см. QRStartView). confirmed отдаёт токены РОВНО
    один раз: следующий же поллинг тем же token'ом застанет запись уже
    удалённой, второй раз ничего не унесёт."""

    permission_classes = [permissions.AllowAny]

    def get(self, request, token):
        qr = _get_live_qr(token)
        if qr is None:
            return Response({"status": "expired"})

        data = {"status": qr.status}
        if qr.status == QRLoginRequest.SCANNED:
            data["code"] = qr.code
        elif qr.status == QRLoginRequest.CONFIRMED:
            data["access"] = qr.access_token
            data["refresh"] = qr.refresh_token
            data["user"] = MeSerializer(qr.user).data
            # Этот GET выполняет сам браузер ПК — самое подходящее место
            # завести ему и Django-сессию (см. LoginView/RegisterView), иначе
            # вход по QR не пускал бы в /adminpskordpro/ и молча оставлял бы
            # старую sessionid-куку от прошлого пользователя на этом ПК.
            django_login(request, qr.user)
            qr.delete()
        elif qr.status == QRLoginRequest.DENIED:
            qr.delete()
        return Response(data)


class QRScanView(APIView):
    """Телефон (уже залогиненный — IsAuthenticated по умолчанию) сканирует
    QR и получает варианты кода + инфо об устройстве, которое логинится,
    чтобы показать человеку "это точно вы?" перед подтверждением."""

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request, token):
        qr = _get_live_qr(token)
        if qr is None or qr.status != QRLoginRequest.PENDING:
            return Response(
                {"detail": "QR-код недействителен или уже использован."}, status=404)

        correct, candidates = _generate_qr_code_candidates()
        qr.user = request.user
        qr.code = correct
        qr.candidates = candidates
        qr.status = QRLoginRequest.SCANNED
        qr.save(update_fields=["user", "code", "candidates", "status"])

        return Response({
            "candidates": candidates,
            "device": {
                "ip_address": qr.ip_address,
                "user_agent": qr.user_agent,
            },
        })


class QRConfirmView(APIView):
    """Телефон подтверждает, выбрав код, который видит на ПК, из вариантов,
    показанных на /scan. Неверный выбор сразу гасит весь запрос (DENIED) —
    не даёт тыкать варианты по кругу."""

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request, token):
        qr = _get_live_qr(token)
        if qr is None or qr.status != QRLoginRequest.SCANNED or qr.user_id != request.user.id:
            return Response({"detail": "Запрос не найден."}, status=404)

        chosen = str(request.data.get("code") or "")
        if chosen not in qr.candidates or chosen != qr.code:
            qr.status = QRLoginRequest.DENIED
            qr.save(update_fields=["status"])
            return Response({"detail": "Неверный код."}, status=400)

        tokens = tokens_for(qr.user)
        record_login_session(qr.user, tokens["refresh"], qr.ip_address, qr.user_agent)
        qr.access_token = tokens["access"]
        qr.refresh_token = tokens["refresh"]
        qr.status = QRLoginRequest.CONFIRMED
        qr.save(update_fields=["access_token", "refresh_token", "status"])
        return Response(status=204)
