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
