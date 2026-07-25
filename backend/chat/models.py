from django.conf import settings
from django.db import models


class Server(models.Model):
    """Аналог Discord-сервера (гильдии)."""

    # Как попасть на сервер (вкладка «Доступ» редактора сервера).
    ACCESS_INVITE = "invite"
    ACCESS_REQUEST = "request"
    ACCESS_PUBLIC = "public"
    ACCESS_CHOICES = [
        (ACCESS_INVITE, "Только по приглашению"),
        (ACCESS_REQUEST, "По заявке"),
        (ACCESS_PUBLIC, "Публичный"),
    ]

    name = models.CharField(max_length=100)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_servers",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    # data-URL значка сервера (до 512x512, жмётся клиентом) — тот же приём
    # хранения, что и accounts.User.avatar_image: картинка маленькая, ради
    # неё не заводим MEDIA_ROOT. Пусто — в ServerRail рисуются инициалы.
    icon = models.TextField(blank=True, default="")
    # Баннер карточки сервера — ровно как баннер профиля (accounts.User):
    # либо строгий CSS-градиент, либо гифка/картинка data-URL (побеждает она).
    banner_gradient = models.CharField(max_length=120, blank=True, default="")
    banner_image = models.TextField(blank=True, default="")
    description = models.TextField(blank=True, default="")
    # «Особенности» сервера — короткие теги для поиска серверов и подсказки
    # при наведении. Список строк; JSONField, потому что это чистые данные
    # для отображения, отдельная таблица под них избыточна.
    tags = models.JSONField(default=list, blank=True)
    # Приватный сервер: описание/особенности/участников видят только свои
    # (см. chat.views.ServerDiscover и ServerSerializer.to_representation).
    is_private = models.BooleanField(default=False)
    access_mode = models.CharField(
        max_length=10, choices=ACCESS_CHOICES, default=ACCESS_PUBLIC)
    age_restricted = models.BooleanField(default=False)
    # Правила сервера — список {"title": ..., "text": ...}, показывается
    # новичкам. Тоже JSONField по той же причине, что и tags.
    rules = models.JSONField(default=list, blank=True)

    def __str__(self) -> str:
        return self.name


class Role(models.Model):
    """Роль на сервере — набор прав, выдаваемый участникам (Membership.roles).

    Права хранятся отдельными булевыми полями, а не битовой маской: их
    немного, они редко меняются, а читаемость в админке/миграциях и
    возможность фильтровать запросом того стоят. Полный список полей (и их
    порядок в UI) — chat.roles.PERMISSION_FIELDS; при добавлении права
    правьте оба места.
    """

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="roles")
    name = models.CharField(max_length=100)
    color = models.CharField(max_length=7, default="#99aab5")
    position = models.PositiveIntegerField(default=0)
    # Роль по умолчанию (аналог @everyone): её права действуют на всех
    # участников сервера, её нельзя удалить и не нужно никому выдавать.
    is_default = models.BooleanField(default=False)

    # --- общие права сервера ---
    view_channels = models.BooleanField(default=True)
    manage_channels = models.BooleanField(default=False)
    manage_roles = models.BooleanField(default=False)
    manage_server = models.BooleanField(default=False)
    manage_invites = models.BooleanField(default=False)
    manage_nicknames = models.BooleanField(default=False)
    # Выгонять/одобрять заявки/банить/разбанить участников.
    manage_members = models.BooleanField(default=False)

    # --- права текстового канала ---
    send_messages = models.BooleanField(default=True)
    delete_messages = models.BooleanField(default=False)
    mention_everyone = models.BooleanField(default=False)

    # --- права голосового канала ---
    speak = models.BooleanField(default=True)
    video = models.BooleanField(default=True)

    class Meta:
        ordering = ["-position", "id"]

    def __str__(self) -> str:
        return f"{self.name} @ {self.server_id}"


class Membership(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    server = models.ForeignKey(
        Server,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    # Роль по умолчанию (is_default) сюда не пишется — она и так действует
    # на всех участников, см. chat.roles.permissions_for.
    roles = models.ManyToManyField(Role, blank=True, related_name="members")

    class Meta:
        unique_together = ("user", "server")

    def __str__(self) -> str:
        return f"{self.user} @ {self.server}"


class ServerJoinRequest(models.Model):
    """Заявка на вступление — создаётся вместо мгновенного Membership, если
    сервер принимает по заявке (Server.ACCESS_REQUEST). Одобрение/отклонение —
    вкладка «Запросы» редактора сервера (нужно право manage_members)."""

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="join_requests")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="server_join_requests")
    message = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("server", "user")
        ordering = ["created_at", "id"]

    def __str__(self) -> str:
        return f"{self.user} -> {self.server}"


class ServerBan(models.Model):
    """Бан на сервере («ЧС списочек»). Пока строка есть — вступить нельзя,
    а участник при бане теряет Membership (см. chat.views.ServerMemberBan)."""

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="bans")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="server_bans")
    banned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="issued_server_bans")
    reason = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("server", "user")
        ordering = ["-created_at", "id"]

    def __str__(self) -> str:
        return f"{self.user} banned @ {self.server}"


class Channel(models.Model):
    TEXT = "text"
    VOICE = "voice"
    KIND_CHOICES = [(TEXT, "Text"), (VOICE, "Voice")]

    server = models.ForeignKey(
        Server,
        on_delete=models.CASCADE,
        related_name="channels",
    )
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, default=TEXT)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:
        return f"{self.server.name}#{self.name}"


class Message(models.Model):
    channel = models.ForeignKey(
        Channel,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    content = models.TextField()
    reply_to = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="replies",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self) -> str:
        return f"{self.author}: {self.content[:30]}"


_DM_ROOM_PREFIX = "dm_"


def dm_room(conversation_id) -> str:
    """Синтетический room-id для chat.presence/sfu.access_token — оба
    работают с channel_id как с непрозрачной строкой (просто ключ Redis /
    поле в JWT), так что звонки в личке/группе переиспользуют их без
    единой правки, просто передавая эту строку вместо настоящего Channel.id."""
    return f"{_DM_ROOM_PREFIX}{conversation_id}"


def is_dm_room(room) -> bool:
    """Отличает комнату диалога/группы от настоящего Channel.id в местах,
    где presence отдаёт «текущую комнату» юзера безлично (просто строку) —
    см. GatewayConsumer._handle_voice_leave/_mute_update/_screen_share_update."""
    return isinstance(room, str) and room.startswith(_DM_ROOM_PREFIX)


def dm_conversation_id(room: str) -> int:
    return int(room[len(_DM_ROOM_PREFIX):])


class Conversation(models.Model):
    """Личка (dm, ровно 2 участника) или групповой чат (group, 2+) — вне
    серверов/каналов. Голос переиспользует chat.presence как есть: комнатой
    для presence/SFU служит синтетический room=f"dm_{conversation.id}" (см.
    chat.consumers._dm_room), а не отдельная модель — presence.py работает
    с channel_id как с непрозрачной строкой, ему всё равно."""

    DM = "dm"
    GROUP = "group"
    KIND_CHOICES = [(DM, "Личное сообщение"), (GROUP, "Группа")]

    kind = models.CharField(max_length=10, choices=KIND_CHOICES)
    # Только для group; опционально — пусто показывается как список имён
    # участников на фронте (как безымянная групповая ЛС в Discord).
    name = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    participants = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through="ConversationParticipant",
        related_name="conversations",
    )

    def __str__(self) -> str:
        return self.name or f"conversation#{self.id}"


class ConversationParticipant(models.Model):
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="conversation_memberships")
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("conversation", "user")

    def __str__(self) -> str:
        return f"{self.user} in {self.conversation}"


class ConversationMessage(models.Model):
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="messages")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="conversation_messages")
    content = models.TextField()
    reply_to = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="replies")
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self) -> str:
        return f"{self.author}: {self.content[:30]}"
