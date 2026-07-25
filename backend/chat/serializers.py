import base64
import binascii

from rest_framework import serializers

from accounts.serializers import (
    ALLOWED_AVATAR_MIME, ALLOWED_BANNER_MIME, GRADIENT_RE, MAX_BANNER_BYTES,
    UserSerializer,
)

from . import presence, roles
from .models import (
    Channel, Conversation, ConversationMessage, Message, Role, Server,
    ServerBan, ServerJoinRequest, dm_room,
)

# Значок сервера жмётся клиентом до 512x512 (ServerSettingsModal.ICON_SIZE) —
# лимит тот же по смыслу, что и у аватара пользователя: защита от запросов
# в обход клиента, а не рабочий предел.
MAX_ICON_BYTES = 1_500_000

# Сколько «особенностей»/правил вообще имеет смысл хранить — не техническое
# ограничение, а защита от бесконечного списка в JSONField.
MAX_TAGS = 12
MAX_TAG_LEN = 32
MAX_RULES = 20


def _validate_data_url(value, allowed_mime, max_bytes, what):
    """Общая проверка картинки-data-URL (значок/баннер сервера) — тот же
    разбор, что и в accounts.serializers для аватара/баннера профиля."""
    if not value:
        return value
    if not value.startswith("data:"):
        raise serializers.ValidationError("Ожидался data-URL картинки.")
    header, _, b64data = value.partition(",")
    mime = header[len("data:"):].split(";")[0]
    if mime not in allowed_mime:
        raise serializers.ValidationError("Неподдерживаемый формат картинки.")
    try:
        decoded = base64.b64decode(b64data, validate=True)
    except (binascii.Error, ValueError):
        raise serializers.ValidationError(f"Битые данные ({what}).")
    if len(decoded) > max_bytes:
        raise serializers.ValidationError(f"Слишком большой файл ({what}).")
    return value


class ChannelSerializer(serializers.ModelSerializer):
    # Длительность текущего разговора и статус — только для голосовых
    # каналов, живут в presence (Redis), пока в канале кто-то есть.
    call_started_at = serializers.SerializerMethodField()
    topic = serializers.SerializerMethodField()

    class Meta:
        model = Channel
        fields = ["id", "server", "name", "kind", "position",
                  "call_started_at", "topic"]
        read_only_fields = ["server"]

    def get_call_started_at(self, obj):
        if obj.kind != Channel.VOICE:
            return None
        return presence.call_started_at(obj.id)

    def get_topic(self, obj):
        if obj.kind != Channel.VOICE:
            return None
        return presence.call_topic(obj.id)


class RoleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Role
        fields = ["id", "name", "color", "position", "is_default",
                  *roles.PERMISSION_NAMES]

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Нужно название роли.")
        return value


class ServerSerializer(serializers.ModelSerializer):
    channels = ChannelSerializer(many=True, read_only=True)
    # Права ЗАПРАШИВАЮЩЕГО на этом сервере — фронт по ним решает, показывать
    # ли шестерёнку редактора, кнопку «+ канал» и т.п. Без request в
    # контексте (например, при рассылке через WS) прав нет — фронт в таких
    # местах и так использует уже загруженный объект сервера.
    my_permissions = serializers.SerializerMethodField()
    member_count = serializers.SerializerMethodField()

    class Meta:
        model = Server
        fields = [
            "id", "name", "owner", "created_at", "channels", "icon",
            "banner_gradient", "banner_image", "description", "tags",
            "is_private", "access_mode", "age_restricted", "rules",
            "my_permissions", "member_count",
        ]
        read_only_fields = ["owner", "created_at"]

    def get_my_permissions(self, obj):
        request = self.context.get("request")
        if request is None:
            return roles.no_permissions()
        return roles.permissions_for(request.user, obj)

    def get_member_count(self, obj):
        return obj.memberships.count()


class ServerUpdateSerializer(serializers.ModelSerializer):
    """PATCH /api/servers/<id> — вкладки «Профиль» и «Доступ» редактора."""

    class Meta:
        model = Server
        fields = [
            "name", "icon", "banner_gradient", "banner_image", "description",
            "tags", "is_private", "access_mode", "age_restricted", "rules",
        ]
        extra_kwargs = {field: {"required": False} for field in fields}

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Имя сервера не может быть пустым.")
        return value

    def validate_icon(self, value):
        return _validate_data_url(
            value, ALLOWED_AVATAR_MIME, MAX_ICON_BYTES, "значок сервера")

    def validate_banner_image(self, value):
        return _validate_data_url(
            value, ALLOWED_BANNER_MIME, MAX_BANNER_BYTES, "баннер сервера")

    def validate_banner_gradient(self, value):
        if value and not GRADIENT_RE.match(value):
            raise serializers.ValidationError("Некорректный формат градиента.")
        return value

    def validate_tags(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Особенности — список строк.")
        cleaned = []
        for tag in value:
            if not isinstance(tag, str):
                raise serializers.ValidationError("Особенности — список строк.")
            tag = tag.strip()[:MAX_TAG_LEN]
            if tag and tag not in cleaned:
                cleaned.append(tag)
        return cleaned[:MAX_TAGS]

    def validate_rules(self, value):
        """Правила — список {"title", "text"}; лишние ключи отбрасываем,
        чтобы в JSONField не попадало что попало из запроса."""
        if not isinstance(value, list):
            raise serializers.ValidationError("Правила — список объектов.")
        cleaned = []
        for rule in value[:MAX_RULES]:
            if not isinstance(rule, dict):
                raise serializers.ValidationError("Правило — объект.")
            title = str(rule.get("title", "")).strip()[:120]
            text = str(rule.get("text", "")).strip()[:2000]
            if title or text:
                cleaned.append({"title": title, "text": text})
        return cleaned


class ServerJoinRequestSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = ServerJoinRequest
        fields = ["id", "user", "message", "created_at"]


class ServerBanSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)
    banned_by = UserSerializer(read_only=True)

    class Meta:
        model = ServerBan
        fields = ["id", "user", "banned_by", "reason", "created_at"]


class MessageReplySerializer(serializers.ModelSerializer):
    """Компактный превью сообщения, на которое отвечают — без вложенности."""
    author = UserSerializer(read_only=True)

    class Meta:
        model = Message
        fields = ["id", "author", "content"]


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    reply_to = MessageReplySerializer(read_only=True)

    class Meta:
        model = Message
        fields = ["id", "channel", "author", "content", "reply_to",
                  "created_at", "edited_at"]
        read_only_fields = ["author", "created_at", "edited_at"]


class ConversationMessageReplySerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)

    class Meta:
        model = ConversationMessage
        fields = ["id", "author", "content"]


class ConversationMessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    reply_to = ConversationMessageReplySerializer(read_only=True)

    class Meta:
        model = ConversationMessage
        fields = ["id", "conversation", "author", "content", "reply_to",
                  "created_at", "edited_at"]
        read_only_fields = ["author", "created_at", "edited_at"]


class ConversationSerializer(serializers.ModelSerializer):
    # Собеседник(и) без себя самого — фронту не нужно самому себя вычитать
    # из списка при отрисовке заголовка/аватара диалога.
    participants = serializers.SerializerMethodField()
    last_message = serializers.SerializerMethodField()
    # Звонок в этом диалоге/группе живёт в том же presence, что и голосовые
    # каналы серверов — просто под синтетическим room (см. models.dm_room).
    call_started_at = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = ["id", "kind", "name", "created_at", "participants",
                  "last_message", "call_started_at"]

    def get_participants(self, obj):
        request = self.context.get("request")
        qs = obj.participants.all()
        if request is not None:
            qs = qs.exclude(id=request.user.id)
        return UserSerializer(qs, many=True).data

    def get_last_message(self, obj):
        last = obj.messages.order_by("-created_at").first()
        if not last:
            return None
        return {
            "content": last.content,
            "author_id": last.author_id,
            "created_at": last.created_at,
        }

    def get_call_started_at(self, obj):
        return presence.call_started_at(dm_room(obj.id))
