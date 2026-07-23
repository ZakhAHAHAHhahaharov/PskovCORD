from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.serializers import UserSerializer

from . import presence, turn
from .models import Channel, Membership, Message, Server
from .serializers import ChannelSerializer, MessageSerializer, ServerSerializer


def is_member(user, server) -> bool:
    return Membership.objects.filter(user=user, server=server).exists()


class ServerListCreate(APIView):
    def get(self, request):
        servers = Server.objects.filter(memberships__user=request.user).distinct()
        return Response(ServerSerializer(servers, many=True).data)

    @transaction.atomic
    def post(self, request):
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "Нужно имя сервера."}, status=400)
        server = Server.objects.create(name=name, owner=request.user)
        Membership.objects.create(user=request.user, server=server)
        # Каналы по умолчанию — как в Discord.
        Channel.objects.create(server=server, name="general",
                               kind=Channel.TEXT, position=0)
        Channel.objects.create(server=server, name="General",
                               kind=Channel.VOICE, position=1)
        return Response(ServerSerializer(server).data, status=201)


class ServerDiscover(APIView):
    """Список всех серверов (дружеский масштаб) — чтобы можно было вступить."""

    def get(self, request):
        servers = Server.objects.all().order_by("-created_at")
        data = []
        for s in servers:
            data.append({
                "id": s.id,
                "name": s.name,
                "member_count": s.memberships.count(),
                "is_member": is_member(request.user, s),
            })
        return Response(data)


class ServerDetail(APIView):
    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        return Response(ServerSerializer(server).data)


class ServerJoin(APIView):
    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        Membership.objects.get_or_create(user=request.user, server=server)
        return Response(ServerSerializer(server).data, status=200)


class ServerMembers(APIView):
    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        members = [m.user for m in server.memberships.select_related("user")]
        data = []
        for u in members:
            data.append({
                **UserSerializer(u).data,
                "online": presence.is_online(u.id),
                "voice_channel": presence.voice_channel(u.id),
            })
        # Онлайн сверху, затем по имени.
        data.sort(key=lambda x: (not x["online"], x["username"].lower()))
        return Response(data)


class ChannelCreate(APIView):
    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        name = (request.data.get("name") or "").strip()
        kind = request.data.get("kind", Channel.TEXT)
        if not name:
            return Response({"detail": "Нужно имя канала."}, status=400)
        if kind not in (Channel.TEXT, Channel.VOICE):
            return Response({"detail": "kind = text | voice."}, status=400)
        position = server.channels.count()
        channel = Channel.objects.create(
            server=server, name=name, kind=kind, position=position)
        return Response(ChannelSerializer(channel).data, status=201)


class ChannelMessages(APIView):
    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        if not is_member(request.user, channel.server):
            return Response({"detail": "Нет доступа."}, status=403)
        qs = channel.messages.select_related("author").order_by("-created_at")[:50]
        messages = list(reversed(qs))
        return Response(MessageSerializer(messages, many=True).data)


class ChannelVoiceMembers(APIView):
    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        if not is_member(request.user, channel.server):
            return Response({"detail": "Нет доступа."}, status=403)
        return Response({"user_ids": list(presence.voice_member_ids(channel_id))})


class VoiceCredentials(APIView):
    def post(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        if channel.kind != Channel.VOICE:
            return Response({"detail": "Не голосовой канал."}, status=400)
        if not is_member(request.user, channel.server):
            return Response({"detail": "Нет доступа."}, status=403)
        ttl = 3600
        return Response({
            "ice_servers": turn.ice_servers(request.user.id, ttl=ttl),
            "ttl": ttl,
        })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def config_view(request):
    from django.conf import settings
    return Response({"app_name": settings.APP_NAME})
