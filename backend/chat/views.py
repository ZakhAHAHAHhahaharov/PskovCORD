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

from . import presence, roles, sfu
from .models import (
    Channel, Conversation, ConversationMessage, ConversationParticipant,
    Membership, Message, Role, Server, ServerBan, ServerJoinRequest, dm_room,
)
from .permissions import are_friends, can_dm
from .serializers import (
    ChannelSerializer, ConversationMessageSerializer, ConversationSerializer,
    MessageSerializer, RoleSerializer, ServerBanSerializer,
    ServerJoinRequestSerializer, ServerSerializer, ServerUpdateSerializer,
)

User = get_user_model()


def is_member(user, server) -> bool:
    return Membership.objects.filter(user=user, server=server).exists()


def _require_permission(request, server, permission):
    """Общая проверка доступа к «управляющим» ручкам сервера: возвращает
    готовый 403-Response, если права нет, иначе None. Не участник сервера
    прав не имеет вообще (см. chat.roles.permissions_for), так что отдельная
    проверка членства тут не нужна."""
    if roles.has_permission(request.user, server, permission):
        return None
    return Response({"detail": "Недостаточно прав на сервере."}, status=403)


def _broadcast_server_update(server, request=None):
    """Разослать участникам обновлённый сервер — иначе изменения из редактора
    (имя, значок, каналы в правах и т.п.) видит только тот, кто их внёс, до
    перезагрузки страницы. Тот же приём, что и channel_create."""
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"server_{server.id}", {"type": "broadcast", "payload": {
            "op": "server_update",
            # Без request в контексте my_permissions уедет пустым — фронт
            # мержит только «общие» поля сервера, свои права он уже знает
            # из первоначальной загрузки (см. AppShell: server_update).
            "server": ServerSerializer(server).data,
        }})


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
        return Response(
            ServerSerializer(servers, many=True, context={"request": request}).data)

    @transaction.atomic
    def post(self, request):
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "Нужно имя сервера."}, status=400)
        server = Server.objects.create(name=name, owner=request.user)
        Membership.objects.create(user=request.user, server=server)
        # Роль по умолчанию (аналог @everyone) — есть на каждом сервере,
        # именно её права действуют на всех участников без ролей.
        roles.create_default_role(server)
        # Каналы по умолчанию — как в Discord.
        Channel.objects.create(server=server, name="general",
                               kind=Channel.TEXT, position=0)
        Channel.objects.create(server=server, name="General",
                               kind=Channel.VOICE, position=1)
        return Response(
            ServerSerializer(server, context={"request": request}).data, status=201)


class ServerDiscover(APIView):
    """Список всех серверов (дружеский масштаб) — чтобы можно было вступить."""

    def get(self, request):
        servers = Server.objects.all().order_by("-created_at")
        my_requests = set(
            ServerJoinRequest.objects.filter(user=request.user).values_list(
                "server_id", flat=True)
        )
        data = []
        for s in servers:
            member = is_member(request.user, s)
            entry = {
                "id": s.id,
                "name": s.name,
                "icon": s.icon,
                "member_count": s.memberships.count(),
                "is_member": member,
                "is_private": s.is_private,
                "access_mode": s.access_mode,
                "age_restricted": s.age_restricted,
                "request_pending": s.id in my_requests,
            }
            # Приватный сервер показывает посторонним только имя и значок —
            # описание/особенности видят лишь участники (см. Server.is_private).
            if s.is_private and not member:
                entry.update({"description": "", "tags": []})
            else:
                entry.update({"description": s.description, "tags": s.tags})
            data.append(entry)
        return Response(data)


class ServerDetail(APIView):
    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        return Response(
            ServerSerializer(server, context={"request": request}).data)

    def patch(self, request, server_id):
        """Вкладки «Профиль» и «Доступ» редактора сервера."""
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_server")
        if denied:
            return denied
        serializer = ServerUpdateSerializer(server, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        _broadcast_server_update(server)
        return Response(
            ServerSerializer(server, context={"request": request}).data)


class ServerJoin(APIView):
    """Вступление с учётом вкладки «Доступ»: публичный сервер пускает сразу,
    «по заявке» — создаёт ServerJoinRequest (ждём одобрения), «только по
    приглашению» — отказ. Забаненных не пускает ни в каком режиме."""

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if is_member(request.user, server):
            return Response(
                ServerSerializer(server, context={"request": request}).data, status=200)

        if ServerBan.objects.filter(server=server, user=request.user).exists():
            return Response({"detail": "Вы забанены на этом сервере."}, status=403)

        if server.access_mode == Server.ACCESS_INVITE:
            return Response(
                {"detail": "Сервер только по приглашению."}, status=403)

        if server.access_mode == Server.ACCESS_REQUEST:
            join_request, created = ServerJoinRequest.objects.get_or_create(
                server=server, user=request.user,
                defaults={"message": str(request.data.get("message") or "")[:2000]},
            )
            if created:
                _notify_server_managers(server, {
                    "op": "server_join_request",
                    "server_id": server.id,
                    "request": ServerJoinRequestSerializer(join_request).data,
                })
            return Response(
                {"status": "pending", "detail": "Заявка отправлена — ждите одобрения."},
                status=202,
            )

        Membership.objects.get_or_create(user=request.user, server=server)
        return Response(
            ServerSerializer(server, context={"request": request}).data, status=200)


def _notify_server_managers(server, payload):
    """Уведомление о событии, которое интересно только модерации сервера
    (новая заявка на вступление). Шлём в общую группу сервера — фронт сам
    решает, показывать ли (у него уже есть свои my_permissions), потому что
    персональные группы пришлось бы перебирать по всем участникам."""
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"server_{server.id}", {"type": "broadcast", "payload": payload})


class ServerMembers(APIView):
    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        memberships = server.memberships.select_related("user").prefetch_related("roles")
        data = []
        for m in memberships:
            u = m.user
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
                "role_ids": [r.id for r in m.roles.all()],
                "is_owner": u.id == server.owner_id,
            })
        # Онлайн сверху, затем по имени.
        data.sort(key=lambda x: (not x["online"], x["username"].lower()))
        return Response(data)


class ServerMemberDetail(APIView):
    """Выдача ролей участнику (PATCH {"role_ids": [...]}) и исключение
    его с сервера (DELETE) — вкладка «Роли» редактора."""

    def patch(self, request, server_id, user_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_roles")
        if denied:
            return denied
        membership = get_object_or_404(Membership, server=server, user_id=user_id)
        role_ids = request.data.get("role_ids")
        if not isinstance(role_ids, list):
            return Response({"detail": "role_ids — список id ролей."}, status=400)
        # Роль по умолчанию действует на всех и не выдаётся персонально —
        # молча отбрасываем её, чтобы фронт не мог создать расхождение.
        valid = Role.objects.filter(
            server=server, id__in=role_ids, is_default=False)
        membership.roles.set(valid)
        return Response({"user_id": user_id, "role_ids": [r.id for r in valid]})

    def delete(self, request, server_id, user_id):
        """Выгнать участника (без бана — вступить сможет снова)."""
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        if user_id == server.owner_id:
            return Response({"detail": "Нельзя выгнать владельца сервера."}, status=400)
        Membership.objects.filter(server=server, user_id=user_id).delete()
        return Response(status=204)


class ServerRoles(APIView):
    """GET — список ролей сервера (виден всем участникам: фронту нужны имена
    и цвета), POST — создать роль (нужно manage_roles)."""

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        return Response(RoleSerializer(server.roles.all(), many=True).data)

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_roles")
        if denied:
            return denied
        serializer = RoleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # Роль по умолчанию на сервере ровно одна и создаётся вместе с ним —
        # через API вторую завести нельзя.
        serializer.save(server=server, is_default=False)
        return Response(serializer.data, status=201)


class ServerRoleDetail(APIView):
    def patch(self, request, server_id, role_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_roles")
        if denied:
            return denied
        role = get_object_or_404(Role, id=role_id, server=server)
        serializer = RoleSerializer(role, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(is_default=role.is_default)
        return Response(serializer.data)

    def delete(self, request, server_id, role_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_roles")
        if denied:
            return denied
        role = get_object_or_404(Role, id=role_id, server=server)
        if role.is_default:
            return Response(
                {"detail": "Роль по умолчанию удалить нельзя."}, status=400)
        role.delete()
        return Response(status=204)


class ServerJoinRequests(APIView):
    """Вкладка «Запросы» — заявки на вступление."""

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        qs = server.join_requests.select_related("user")
        return Response(ServerJoinRequestSerializer(qs, many=True).data)


class ServerJoinRequestDecision(APIView):
    """POST — одобрить заявку (создаёт Membership), DELETE — отклонить."""

    def post(self, request, server_id, request_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        join_request = get_object_or_404(
            ServerJoinRequest, id=request_id, server=server)
        Membership.objects.get_or_create(user=join_request.user, server=server)
        user_id = join_request.user_id
        join_request.delete()
        # Заявитель узнаёт об одобрении сразу — он не подписан на группу
        # сервера, пока не стал участником, поэтому личным уведомлением.
        _notify_user(user_id, {
            "op": "server_join_approved",
            "server": ServerSerializer(server).data,
        })
        return Response({"status": "approved", "user_id": user_id})

    def delete(self, request, server_id, request_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        get_object_or_404(
            ServerJoinRequest, id=request_id, server=server).delete()
        return Response(status=204)


class ServerBans(APIView):
    """Вкладка «ЧС списочек»: GET — список банов, POST {"user_id", "reason"} —
    забанить (участник заодно теряет членство)."""

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        qs = server.bans.select_related("user", "banned_by")
        return Response(ServerBanSerializer(qs, many=True).data)

    @transaction.atomic
    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        target = get_object_or_404(User, id=request.data.get("user_id"))
        if target.id == server.owner_id:
            return Response({"detail": "Нельзя забанить владельца сервера."}, status=400)
        ban, _created = ServerBan.objects.get_or_create(
            server=server, user=target,
            defaults={
                "banned_by": request.user,
                "reason": str(request.data.get("reason") or "")[:300],
            },
        )
        Membership.objects.filter(server=server, user=target).delete()
        ServerJoinRequest.objects.filter(server=server, user=target).delete()
        return Response(ServerBanSerializer(ban).data, status=201)


class ServerBanDetail(APIView):
    def delete(self, request, server_id, user_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        ServerBan.objects.filter(server=server, user_id=user_id).delete()
        return Response(status=204)


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
        denied = _require_permission(request, server, "manage_channels")
        if denied:
            return denied
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
