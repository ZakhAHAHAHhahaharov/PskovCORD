from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import Friendship
from accounts.serializers import UserSerializer

from . import presence, sfu
from .models import (
    Channel, Conversation, ConversationMessage, ConversationParticipant,
    Membership, Message, Server, dm_room,
)
from .permissions import are_friends, can_dm
from .serializers import (
    ChannelSerializer, ConversationMessageSerializer, ConversationSerializer,
    MessageSerializer, ServerSerializer,
)

User = get_user_model()


def is_member(user, server) -> bool:
    return Membership.objects.filter(user=user, server=server).exists()


def is_participant(user, conversation) -> bool:
    return ConversationParticipant.objects.filter(
        user=user, conversation=conversation).exists()


def _notify_user(user_id, payload):
    """Личное уведомление конкретному юзеру (заявка в друзья, новый диалог,
    входящий звонок) — через персональную группу user_{id} в channel layer
    (см. chat.consumers.GatewayConsumer.connect), а не server_{id}/
    conversation_{id}: адресат может быть не подписан ни на одну из них
    в момент события (например, только что созданный диалог)."""
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"user_{user_id}", {"type": "broadcast", "payload": payload})


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
            is_on = presence.is_online(u.id)
            eff_status = presence.effective_status(u, is_on)
            flags = presence.voice_flags(u.id)
            data.append({
                **UserSerializer(u).data,
                "online": eff_status != "offline",
                "status": eff_status,
                "voice_channel": presence.voice_channel(u.id),
                "muted": flags["muted"],
                "deafened": flags["deafened"],
                "sharing_screen": flags["sharing_screen"],
            })
        # Онлайн сверху, затем по имени.
        data.sort(key=lambda x: (not x["online"], x["username"].lower()))
        return Response(data)


class FriendsView(APIView):
    """GET /api/friends — мои друзья + входящие/исходящие заявки."""

    def get(self, request):
        accepted = Friendship.objects.filter(
            status=Friendship.ACCEPTED
        ).filter(
            Q(from_user=request.user) | Q(to_user=request.user)
        ).select_related("from_user", "to_user")
        friends = [
            f.to_user if f.from_user_id == request.user.id else f.from_user
            for f in accepted
        ]
        incoming = Friendship.objects.filter(
            to_user=request.user, status=Friendship.PENDING
        ).select_related("from_user")
        outgoing = Friendship.objects.filter(
            from_user=request.user, status=Friendship.PENDING
        ).select_related("to_user")
        return Response({
            "friends": UserSerializer(friends, many=True).data,
            "incoming": [
                {"id": f.id, "user": UserSerializer(f.from_user).data}
                for f in incoming
            ],
            "outgoing": [
                {"id": f.id, "user": UserSerializer(f.to_user).data}
                for f in outgoing
            ],
        })


class FriendRequests(APIView):
    """POST /api/friends/requests {"user_id": N} или {"username": "..."} —
    отправить заявку в друзья (или сразу принять, если встречная уже висит —
    см. ниже). username — для случая, когда добавляешь человека, с которым
    ещё нет общего сервера (значит его не будет и в /api/people/known)."""

    def post(self, request):
        target_id = request.data.get("user_id")
        username = (request.data.get("username") or "").strip()
        if target_id:
            target = get_object_or_404(User, id=target_id)
        elif username:
            target = get_object_or_404(User, username__iexact=username)
        else:
            return Response({"detail": "Нужен user_id или username."}, status=400)
        if target.id == request.user.id:
            return Response({"detail": "Нельзя добавить самого себя."}, status=400)

        if are_friends(request.user, target):
            return Response({"detail": "Уже в друзьях."}, status=400)

        # Встречная заявка уже висит (target -> нас) — сразу мутуально принимаем,
        # вместо создания второй параллельной pending-строки.
        reverse_pending = Friendship.objects.filter(
            from_user=target, to_user=request.user, status=Friendship.PENDING,
        ).first()
        if reverse_pending:
            reverse_pending.status = Friendship.ACCEPTED
            reverse_pending.responded_at = timezone.now()
            reverse_pending.save(update_fields=["status", "responded_at"])
            _notify_user(target.id, {
                "op": "friend_request_accept", "id": reverse_pending.id,
                "user": UserSerializer(request.user).data,
            })
            return Response({"id": reverse_pending.id, "status": "accepted"})

        fr, created = Friendship.objects.get_or_create(
            from_user=request.user, to_user=target,
            defaults={"status": Friendship.PENDING},
        )
        if not created:
            return Response({"detail": "Заявка уже отправлена."}, status=400)
        _notify_user(target.id, {
            "op": "friend_request_create", "id": fr.id,
            "from_user": UserSerializer(request.user).data,
        })
        return Response({"id": fr.id, "status": fr.status}, status=201)


class FriendRequestAccept(APIView):
    def post(self, request, request_id):
        fr = get_object_or_404(
            Friendship, id=request_id, to_user=request.user,
            status=Friendship.PENDING)
        fr.status = Friendship.ACCEPTED
        fr.responded_at = timezone.now()
        fr.save(update_fields=["status", "responded_at"])
        _notify_user(fr.from_user_id, {
            "op": "friend_request_accept", "id": fr.id,
            "user": UserSerializer(request.user).data,
        })
        return Response({"id": fr.id, "status": "accepted"})


class FriendRequestDecline(APIView):
    """Отклонить входящую ИЛИ отозвать исходящую заявку — оба через DELETE
    одной и той же заявки, разница только в том, чьей стороной она была."""

    def delete(self, request, request_id):
        fr = get_object_or_404(
            Friendship.objects.filter(Q(from_user=request.user) | Q(to_user=request.user)),
            id=request_id,
        )
        fr.delete()
        return Response(status=204)


class FriendRemove(APIView):
    def delete(self, request, user_id):
        Friendship.objects.filter(status=Friendship.ACCEPTED).filter(
            Q(from_user_id=user_id, to_user=request.user)
            | Q(from_user=request.user, to_user_id=user_id)
        ).delete()
        return Response(status=204)


class KnownPeople(APIView):
    """GET /api/people/known — люди для пикера «новый диалог/группа»:
    друзья + те, с кем есть общий сервер (та же логика видимости, что уже
    используется для мини-профиля/mutual servers), с пометкой is_friend."""

    def get(self, request):
        friend_ids = set()
        for f in Friendship.objects.filter(
            status=Friendship.ACCEPTED
        ).filter(Q(from_user=request.user) | Q(to_user=request.user)):
            friend_ids.add(
                f.to_user_id if f.from_user_id == request.user.id else f.from_user_id)

        my_server_ids = Membership.objects.filter(
            user=request.user).values_list("server_id", flat=True)
        shared_ids = set(
            Membership.objects.filter(server_id__in=my_server_ids)
            .exclude(user=request.user)
            .values_list("user_id", flat=True)
        )

        ids = friend_ids | shared_ids
        people = User.objects.filter(id__in=ids)
        data = [
            {**UserSerializer(u).data, "is_friend": u.id in friend_ids}
            for u in people
        ]
        data.sort(key=lambda x: (not x["is_friend"], x["username"].lower()))
        return Response(data)


class ConversationListCreate(APIView):
    def get(self, request):
        conversations = Conversation.objects.filter(
            participants=request.user
        ).order_by("-created_at").distinct()
        return Response(
            ConversationSerializer(
                conversations, many=True, context={"request": request}).data
        )

    @transaction.atomic
    def post(self, request):
        kind = request.data.get("kind")
        user_ids = request.data.get("user_ids") or []
        name = (request.data.get("name") or "").strip()

        if kind not in (Conversation.DM, Conversation.GROUP):
            return Response({"detail": "kind = dm | group."}, status=400)
        try:
            user_ids = {int(uid) for uid in user_ids if int(uid) != request.user.id}
        except (TypeError, ValueError):
            return Response({"detail": "user_ids должны быть числами."}, status=400)
        if not user_ids:
            return Response({"detail": "Нужен хотя бы один собеседник."}, status=400)

        if kind == Conversation.DM:
            if len(user_ids) != 1:
                return Response({"detail": "Личка — ровно один собеседник."}, status=400)
            target = get_object_or_404(User, id=next(iter(user_ids)))

            existing = Conversation.objects.filter(
                kind=Conversation.DM, participants=request.user
            ).filter(participants=target).first()
            if existing:
                return Response(
                    ConversationSerializer(existing, context={"request": request}).data
                )

            if not can_dm(request.user, target):
                return Response(
                    {"detail": "Этот пользователь не принимает личные сообщения от вас."},
                    status=403,
                )
            conversation = Conversation.objects.create(kind=Conversation.DM)
            participant_ids = {request.user.id, target.id}
        else:
            users = list(User.objects.filter(id__in=user_ids))
            if not users:
                return Response({"detail": "Участники не найдены."}, status=400)
            conversation = Conversation.objects.create(
                kind=Conversation.GROUP, name=name[:100])
            participant_ids = {request.user.id, *user_ids}

        ConversationParticipant.objects.bulk_create([
            ConversationParticipant(conversation=conversation, user_id=uid)
            for uid in participant_ids
        ])

        data = ConversationSerializer(conversation, context={"request": request}).data
        for uid in participant_ids:
            _notify_user(uid, {"op": "conversation_create", "conversation": data})
        return Response(data, status=201)


class ConversationMessages(APIView):
    def get(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        if not is_participant(request.user, conversation):
            return Response({"detail": "Нет доступа."}, status=403)
        qs = conversation.messages.select_related(
            "author", "reply_to__author").order_by("-created_at")[:50]
        messages = list(reversed(qs))
        return Response(ConversationMessageSerializer(messages, many=True).data)


class ConversationVoiceCredentials(APIView):
    def post(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        if not is_participant(request.user, conversation):
            return Response({"detail": "Нет доступа."}, status=403)
        ttl = 3600
        room = dm_room(conversation.id)
        token = sfu.access_token(
            request.user.id, room, request.user.username, ttl=ttl)
        return Response({
            "sfu_url": settings.SFU_PUBLIC_URL,
            "sfu_token": token,
            "ttl": ttl,
        })


class ChannelCreate(APIView):
    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        if request.user.id != server.owner_id:
            return Response(
                {"detail": "Только владелец сервера может создавать каналы."},
                status=403,
            )
        name = (request.data.get("name") or "").strip()
        kind = request.data.get("kind", Channel.TEXT)
        if not name:
            return Response({"detail": "Нужно имя канала."}, status=400)
        if kind not in (Channel.TEXT, Channel.VOICE):
            return Response({"detail": "kind = text | voice."}, status=400)
        position = server.channels.count()
        channel = Channel.objects.create(
            server=server, name=name, kind=kind, position=position)
        data = ChannelSerializer(channel).data
        # Живое обновление списка каналов у остальных участников сервера —
        # без этого им приходилось перезагружать страницу, чтобы увидеть
        # новый канал (тот же паттерн, что и voice_state_update).
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"server_{server_id}", {"type": "broadcast", "payload": {
                "op": "channel_create",
                "server_id": server_id,
                "channel": data,
            }})
        return Response(data, status=201)


class ChannelMessages(APIView):
    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        if not is_member(request.user, channel.server):
            return Response({"detail": "Нет доступа."}, status=403)
        qs = channel.messages.select_related(
            "author", "reply_to__author").order_by("-created_at")[:50]
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
        # Медиа идёт через собственный SFU (mediasoup). Клиенту нужен адрес
        # сигналинга SFU и короткоживущий токен доступа (uid + room в нём).
        ttl = 3600
        token = sfu.access_token(
            request.user.id, channel_id, request.user.username, ttl=ttl)
        return Response({
            "sfu_url": settings.SFU_PUBLIC_URL,
            "sfu_token": token,
            "ttl": ttl,
        })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def config_view(request):
    return Response({"app_name": settings.APP_NAME})
