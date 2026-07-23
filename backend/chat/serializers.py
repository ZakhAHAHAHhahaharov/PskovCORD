from rest_framework import serializers

from accounts.serializers import UserSerializer

from .models import Channel, Message, Server


class ChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Channel
        fields = ["id", "server", "name", "kind", "position"]
        read_only_fields = ["server"]


class ServerSerializer(serializers.ModelSerializer):
    channels = ChannelSerializer(many=True, read_only=True)

    class Meta:
        model = Server
        fields = ["id", "name", "owner", "created_at", "channels"]
        read_only_fields = ["owner", "created_at"]


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)

    class Meta:
        model = Message
        fields = ["id", "channel", "author", "content", "created_at"]
        read_only_fields = ["author", "created_at"]
