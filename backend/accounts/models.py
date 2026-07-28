from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Пользователь PskovCord. Пока = стандартный Django-юзер + цвет аватара."""

    ONLINE = "online"
    DND = "dnd"
    INVISIBLE = "invisible"
    STATUS_CHOICES = [
        (ONLINE, "В сети"),
        (DND, "Не беспокоить"),
        (INVISIBLE, "Невидимка"),
    ]

    avatar_color = models.CharField(max_length=7, default="#5865F2")
    # Необязательное отображаемое имя (как глобальный display name в
    # Discord) — показывается вместо username в карточке профиля, а сам
    # username под ним отдельной строкой (см. фронт ProfileModal/
    # StatusMenu/MiniProfilePopup). Пусто — используется username, второй
    # строки с ним тогда не показываем (незачем дублировать одно и то же).
    # Уникальности не требует: это просто подпись, а не идентификатор.
    display_name = models.CharField(max_length=64, blank=True, default="")
    # "О себе" в карточке профиля — свободный текст, лимит проверяется на
    # сериализаторе (см. ProfileUpdateSerializer.validate_bio), не здесь —
    # тот же приём, что у Server.description (chat.models).
    bio = models.TextField(blank=True, default="")
    # data-URL (data:image/jpeg;base64,...) — хранится прямо в БД, без
    # ImageField/MEDIA_ROOT/Pillow: аватарки маленькие (сжимаются клиентом до
    # 256x256 перед отправкой), а лишний медиа-сервинг (volume + nginx
    # location, как для static/) для дружеского масштаба избыточен. Пусто —
    # аватара нет, показывается цветной кружок с буквой (avatar_color).
    avatar_image = models.TextField(blank=True, default="")
    # Фон карточки профиля (всплывает над status-menu). Пусто — стандартный
    # градиент по умолчанию (см. фронт). Ровно один из двух источников
    # активен: либо CSS-градиент, либо гифка (banner_image побеждает, если
    # оба почему-то заполнены — так решает фронт при отрисовке).
    banner_gradient = models.CharField(max_length=120, blank=True, default="")
    # data-URL (data:image/gif;base64,...), как avatar_image — та же логика
    # хранения. Не транслируется другим участникам через profile_update
    # (см. accounts.views._broadcast_profile_update): пока используется
    # только в собственной карточке профиля, незачем гонять гифки по WS
    # всем на сервере.
    banner_image = models.TextField(blank=True, default="")
    # Выбирается самим пользователем; фактическая видимость другим (online/dnd/offline)
    # вычисляется отдельно с учётом реального подключения — см. chat.presence_status.
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=ONLINE)

    # Свой набор иконок вкладки (favicon.ico/16x16/32x32/apple-touch и т.д.,
    # см. core.models.Favicon) — пусто означает "стандартная" (см.
    # core.views._resolve_favicon_id / Favicon.get_default_id). SET_NULL —
    # при удалении выбранной иконки пользователь просто откатывается на
    # стандартную, а не теряет аккаунт.
    favicon = models.ForeignKey(
        "core.Favicon",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="selected_by",
        verbose_name="Иконка вкладки",
    )

    DM_FRIENDS = "friends"
    DM_NOBODY = "nobody"
    DM_EVERYONE = "everyone"
    DM_PRIVACY_CHOICES = [
        (DM_FRIENDS, "Только друзья"),
        (DM_NOBODY, "Никто"),
        (DM_EVERYONE, "Любой зарегистрированный"),
    ]
    # Кто может НАЧАТЬ новую личку со мной (см. chat.permissions.can_dm).
    # Не влияет на уже существующие диалоги — если переписка уже началась,
    # ужесточение потом её не рвёт (проверяется только при создании).
    dm_privacy = models.CharField(
        max_length=10, choices=DM_PRIVACY_CHOICES, default=DM_EVERYONE)

    def __str__(self) -> str:
        return self.username


class LoginSession(models.Model):
    """Одна строка на "сеанс" (устройство/браузер) — для «Активные сеансы» в
    настройках. Не привязана к конкретному refresh-токену напрямую: он
    ротируется на каждый /token/refresh (см. SIMPLE_JWT.ROTATE_REFRESH_TOKENS),
    а session_id — кастомный claim, который прописывается один раз при
    логине/регистрации (accounts.views.record_login_session) и переживает
    ротацию как есть (SimpleJWT при роутации переиспользует тот же объект
    токена, просто сбрасывая jti/iat/exp, — остальные claims остаются).
    jti обновляется на каждый refresh, чтобы можно было проверить, что
    сеанс всё ещё жив (см. SessionListView — сверяется с OutstandingToken)."""

    user = models.ForeignKey(
        "accounts.User", related_name="login_sessions", on_delete=models.CASCADE)
    session_id = models.UUIDField(db_index=True)
    # jti текущего (последнего выданного/обновлённого) refresh-токена этого
    # сеанса — см. rest_framework_simplejwt.token_blacklist.OutstandingToken.
    jti = models.CharField(max_length=255, db_index=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["user", "session_id"])]

    def __str__(self) -> str:
        return f"{self.user_id} @ {self.ip_address} ({self.session_id})"


class QRLoginRequest(models.Model):
    """Вход по QR-коду (как в WhatsApp/Telegram Web): страница логина на ПК
    заводит запрос и рисует QR с token'ом, телефон (уже залогиненный)
    сканирует и подтверждает — ПК получает токены поллингом.

    Цифровой код (code/candidates) — не про защиту от подбора (это сделал
    бы сам token, он длинный и случайный), а про то, чтобы человек своими
    глазами сверил ОДИН И ТОТ ЖЕ код на обоих экранах перед подтверждением —
    страховка от релея/подмены QR на фишинговой странице, тот же приём, что
    у Google Sign-in prompt."""

    PENDING = "pending"
    SCANNED = "scanned"
    CONFIRMED = "confirmed"
    DENIED = "denied"
    STATUS_CHOICES = [
        (PENDING, "Ждёт сканирования"),
        (SCANNED, "Отсканирован, ждёт подтверждения"),
        (CONFIRMED, "Подтверждён"),
        (DENIED, "Отклонён"),
    ]

    token = models.CharField(max_length=64, unique=True, db_index=True)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)

    # Устройство, которое ПОКАЗЫВАЕТ QR (то есть то, что логинится) —
    # captured при /qr/start, показывается на телефоне при подтверждении.
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True, default="")

    # Кто сканирует (заполняется при /scan) — этому пользователю в итоге и
    # выдаём токены.
    user = models.ForeignKey(
        "accounts.User", null=True, blank=True,
        related_name="qr_login_requests", on_delete=models.CASCADE)

    code = models.CharField(max_length=2, blank=True, default="")
    # JSON-массив вариантов (включая верный code) — что телефон показывает
    # для выбора. Хранится, чтобы /confirm мог проверить, что выбор вообще
    # был из предложенных, а не просто угадан произвольный текст.
    candidates = models.JSONField(default=list, blank=True)

    # Токены кладутся сюда РОВНО на момент между /confirm и следующим
    # /status с ПК — тот заберёт их один раз и тут же обнулит поля (см.
    # QRStatusView.get), чтобы второй поллинг тем же token'ом ничего не
    # унёс повторно.
    access_token = models.TextField(blank=True, default="")
    refresh_token = models.TextField(blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"qr:{self.token[:8]}… ({self.status})"


class Friendship(models.Model):
    """Заявка в друзья/дружба. Одна строка на пару, направленная
    (from_user отправил to_user), но симметричная по смыслу — is_friend
    смотрит в обе стороны (см. chat.permissions.are_friends). Взаимная
    заявка (B шлёт A, пока уже висит pending A->B) не создаёт вторую
    строку, а сразу принимает существующую — см. chat.views.FriendRequests.post.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    STATUS_CHOICES = [
        (PENDING, "В ожидании"),
        (ACCEPTED, "Приняты"),
    ]

    from_user = models.ForeignKey(
        "accounts.User", related_name="sent_friend_requests",
        on_delete=models.CASCADE)
    to_user = models.ForeignKey(
        "accounts.User", related_name="received_friend_requests",
        on_delete=models.CASCADE)
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default=PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = ("from_user", "to_user")

    def __str__(self) -> str:
        return f"{self.from_user_id} -> {self.to_user_id} ({self.status})"
