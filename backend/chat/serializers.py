from rest_framework import serializers

from accounts.serializers import UserSerializer

from . import presence
from .models import Channel, Message, Server


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
