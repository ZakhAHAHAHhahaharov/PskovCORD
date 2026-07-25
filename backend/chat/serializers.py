from rest_framework import serializers

from accounts.serializers import UserSerializer

from . import presence
from .models import Channel, Conversation, ConversationMessage, Message, Server, dm_room


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


class ServerSerializer(serializers.ModelSerializer):
    channels = ChannelSerializer(many=True, read_only=True)

    class Meta:
        model = Server
        fields = ["id", "name", "owner", "created_at", "channels"]
        read_only_fields = ["owner", "created_at"]


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
