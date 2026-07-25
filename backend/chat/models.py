from django.conf import settings
from django.db import models


class Server(models.Model):
    """Аналог Discord-сервера (гильдии)."""

    name = models.CharField(max_length=100)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_servers",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return self.name


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

    class Meta:
        unique_together = ("user", "server")

    def __str__(self) -> str:
        return f"{self.user} @ {self.server}"


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
