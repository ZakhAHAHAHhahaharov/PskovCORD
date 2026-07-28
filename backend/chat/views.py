from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import Friendship
from accounts.serializers import UserSerializer

from . import presence, roles, sfu, uploads
from .models import (
    Attachment, Channel, Conversation, ConversationMessage,
    ConversationParticipant, Membership, Message, Role, Server, ServerBan,
    ServerJoinRequest, MAX_ATTACHMENT_BYTES, dm_room,
)
from .permissions import are_friends, can_dm
from .serializers import (
    AttachmentSerializer, ChannelSerializer, ConversationMessageSerializer,
    ConversationSerializer, MessageSerializer, RoleSerializer,
    ServerBanSerializer, ServerJoinRequestSerializer, ServerSerializer,
    ServerUpdateSerializer,
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


def _require_role_hierarchy(request, server, data, current_position=None):
    """Проверка иерархии при создании/правке роли. Без неё manage_roles было
    эскалацией до владельца — см. chat.roles, там же вся механика.

    current_position=None означает создание новой роли (менять пока нечего).
    """
    if current_position is not None and not roles.can_manage_role(
        request.user, server, current_position
    ):
        return Response(
            {"detail": "Нельзя управлять ролью не ниже вашей."}, status=403)
    # После правки роль тоже должна остаться ниже своей — иначе её можно было
    # бы «поднять» себе над головой одним PATCH'ем position.
    target_position = data.get(
        "position", current_position if current_position is not None else 0)
    if not roles.can_manage_role(request.user, server, target_position):
        return Response(
            {"detail": "Нельзя поставить роль на уровень не ниже вашего."}, status=403)
    extra = roles.missing_permissions_to_grant(request.user, server, data)
    if extra:
        return Response(
            {"detail": "Нельзя выдать права, которых нет у вас самих: "
                       + ", ".join(extra) + "."},
            status=403,
        )
    return None


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


def _require_channel_access(request, channel, *permissions):
    """Доступ к каналу: членство + view_channels + перечисленные права.

    view_channels и speak раньше не проверялись нигде — роль могла их снять, а
    участник всё равно читал канал и получал голосовой токен, то есть
    «Говорить: выкл» в редакторе ролей ничего не значило.
    """
    if not is_member(request.user, channel.server):
        return Response({"detail": "Нет доступа."}, status=403)
    perms = roles.permissions_for(request.user, channel.server)
    for name in ("view_channels", *permissions):
        if not perms.get(name):
            return Response({"detail": "Недостаточно прав на сервере."}, status=403)
    return None


# Пагинация истории. До этого ручки жёстко отдавали последние 50 сообщений без
# курсора — всё, что старше, было недостижимо из приложения в принципе, сколько
# бы ни копилось в БД.
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100

# Верхняя граница на размер беседы. Раньше её не было вовсе: одним запросом
# можно было завести группу со всеми пользователями инстанса разом.
MAX_CONVERSATION_PARTICIPANTS = 25


def _int_param(request, name):
    raw = request.query_params.get(name)
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _paginate_messages(request, queryset):
    """Курсорная пагинация: ?before=<id> — страница строго старше указанного
    сообщения (скролл вверх), ?after=<id> — то, что появилось после (добор
    пропущенного, когда WS лежал). Без курсора — последняя страница, как
    раньше. Всегда возвращает хронологический порядок."""
    limit = _int_param(request, "limit") or DEFAULT_PAGE_SIZE
    limit = max(1, min(limit, MAX_PAGE_SIZE))

    after = _int_param(request, "after")
    if after is not None:
        # Вперёд берём самые СТАРЫЕ из новых, иначе при большом пропуске в
        # середине образуется дырка, которую клиенту нечем заметить.
        return list(queryset.filter(id__gt=after).order_by("created_at", "id")[:limit])

    before = _int_param(request, "before")
    if before is not None:
        queryset = queryset.filter(id__lt=before)
    return list(queryset.order_by("-created_at", "-id")[:limit])[::-1]


def server_context(request, servers):
    """Контекст для ServerSerializer: request (нужен для my_permissions) плюс
    заранее собранные состояния звонков всех голосовых каналов — одним
    пайплайном вместо двух обращений к Redis на каждый канал во время
    сериализации (см. ChannelSerializer._state)."""
    if isinstance(servers, Server):
        servers = [servers]
    voice_channel_ids = [
        channel.id
        for server in servers
        for channel in server.channels.all()
        if channel.kind == Channel.VOICE
    ]
    return {
        "request": request,
        "call_states": presence.call_states(voice_channel_ids),
    }


def _last_messages(conversation_ids):
    """Последнее сообщение каждой беседы за два запроса — раньше сериализатор
    делал отдельный ORDER BY ... LIMIT 1 на каждую беседу в списке."""
    if not conversation_ids:
        return {}
    latest_ids = list(
        ConversationMessage.objects.filter(conversation_id__in=conversation_ids)
        .values("conversation_id")
        .annotate(last_id=Max("id"))
        .values_list("last_id", flat=True)
    )
    return {
        m.conversation_id: m
        for m in ConversationMessage.objects.filter(id__in=latest_ids)
    }


def conversation_context(request, conversations):
    """Контекст для ConversationSerializer — тем же приёмом, что и
    server_context: состояния звонков одним пайплайном, последние сообщения
    одним запросом."""
    if isinstance(conversations, Conversation):
        conversations = [conversations]
    ids = [c.id for c in conversations]
    return {
        "request": request,
        "call_states": presence.call_states([dm_room(cid) for cid in ids]),
        "last_messages": _last_messages(ids),
    }


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


def _revoke_server_membership(server, user_id):
    """Отписать живые сокеты пользователя от группы сервера.

    GatewayConsumer собирает список server_-групп ровно один раз, в connect()
    (иначе неоткуда узнать об изменении членства), поэтому без этой команды
    выгнанный/забаненный продолжал получать весь чат, presence и voice-state
    сервера до тех пор, пока сам не закроет вкладку. Писать он уже не мог —
    проверки при отправке смотрят в Membership, — а читать мог сколько угодно.
    """
    _notify_user(user_id, {
        "op": "server_membership_revoked",
        "server_id": server.id,
    })


def _grant_server_membership(server, user_id):
    """Зеркальная операция: подписать сокеты только что вступившего.

    Без неё новый участник грузил историю по REST и дальше сидел в тишине —
    ни новых сообщений, ни presence, — пока не перезагрузит страницу.
    """
    _notify_user(user_id, {
        "op": "server_membership_granted",
        "server_id": server.id,
    })


class ServerListCreate(APIView):
    def get(self, request):
        # Фильтр по id, а не join'ом по memberships: с join'ом
        # annotate(Count("memberships")) считал бы только СВОЁ членство (1),
        # а не всех участников сервера — классические грабли аннотации по той
        # же связи, по которой идёт фильтрация.
        my_server_ids = Membership.objects.filter(user=request.user).values_list(
            "server_id", flat=True)
        servers = list(
            Server.objects.filter(id__in=my_server_ids)
            .annotate(member_total=Count("memberships", distinct=True))
            .prefetch_related("channels")
        )
        return Response(
            ServerSerializer(
                servers, many=True, context=server_context(request, servers)).data)

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
            ServerSerializer(server, context=server_context(request, server)).data, status=201)


class ServerDiscover(APIView):
    """Поиск серверов, куда можно вступить: GET /api/servers/discover?q=...

    Приватный сервер (Server.is_private) в выдачу не попадает вообще — ни
    строкой, ни именем. Раньше он показывался всем, просто с вычищенными
    описанием и тегами, то есть «приватность» сводилась к сокрытию витрины:
    сам факт существования сервера, его название, значок и число участников
    видел любой, а по access_mode=public в него ещё и можно было вступить
    прямо из поиска. Теперь приватный сервер виден в этой ручке только своим —
    попасть в него можно лишь зная о нём извне.

    q — подстрока имени или «особенности» (tags). Пустой q отдаёт весь список,
    как раньше: на дружеском масштабе это нормальная витрина.
    """

    # Отдаём не больше этого за раз — на случай, если инстанс однажды
    # перестанет быть «дружеским масштабом»: без лимита ручка вернула бы все
    # сервера сразу.
    MAX_RESULTS = 100

    def get(self, request):
        my_server_ids = set(
            Membership.objects.filter(user=request.user).values_list(
                "server_id", flat=True)
        )
        # Раньше здесь было два N+1 сразу: memberships.count() и is_member() —
        # по отдельному запросу на каждый сервер в списке. Теперь счётчик
        # приезжает аннотацией, а членство — одним множеством.
        servers = Server.objects.annotate(
            member_total=Count("memberships", distinct=True)
        ).filter(
            # Приватные — только те, где мы уже состоим (иначе список «куда
            # вступить» скрывал бы от человека его же собственные сервера).
            Q(is_private=False) | Q(id__in=my_server_ids)
        )

        query = (request.query_params.get("q") or "").strip()
        if query:
            # tags — JSONField со списком строк; icontains по нему сравнивает
            # текстовое представление, чего для «найти по особенности» ровно
            # достаточно и не требует ни отдельной таблицы, ни GIN-индекса.
            servers = servers.filter(
                Q(name__icontains=query) | Q(tags__icontains=query))

        servers = servers.order_by("-created_at")[:self.MAX_RESULTS]

        my_requests = set(
            ServerJoinRequest.objects.filter(user=request.user).values_list(
                "server_id", flat=True)
        )
        return Response([
            {
                "id": s.id,
                "name": s.name,
                "icon": s.icon,
                "member_count": s.member_total,
                "is_member": s.id in my_server_ids,
                "is_private": s.is_private,
                "access_mode": s.access_mode,
                "age_restricted": s.age_restricted,
                "request_pending": s.id in my_requests,
                "description": s.description,
                "tags": s.tags,
            }
            for s in servers
        ])


class ServerDetail(APIView):
    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        return Response(
            ServerSerializer(server, context=server_context(request, server)).data)

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
            ServerSerializer(server, context=server_context(request, server)).data)


class ServerJoin(APIView):
    """Вступление с учётом вкладки «Доступ»: публичный сервер пускает сразу,
    «по заявке» — создаёт ServerJoinRequest (ждём одобрения), «только по
    приглашению» — отказ. Забаненных не пускает ни в каком режиме."""

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if is_member(request.user, server):
            return Response(
                ServerSerializer(server, context=server_context(request, server)).data, status=200)

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
        _grant_server_membership(server, request.user.id)
        return Response(
            ServerSerializer(server, context=server_context(request, server)).data, status=200)


def _notify_server_managers(server, payload):
    """Уведомление о событии, которое интересно только модерации сервера
    (новая заявка на вступление).

    Раньше слалось в общую группу сервера с расчётом «фронт сам решит,
    показывать ли» — то есть профиль заявителя и его сопроводительное
    сообщение (до 2000 символов) получали ВСЕ участники, хотя REST-ручка тех
    же заявок закрыта правом manage_members. Решение о доступе принимает
    сервер, а не клиент: перебираем тех, у кого право реально есть, и шлём
    лично. На дружеском масштабе список модерации короткий.
    """
    for user_id in roles.member_ids_with_permission(server, "manage_members"):
        _notify_user(user_id, payload)


class ServerMembers(APIView):
    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        memberships = list(
            server.memberships.select_related("user").prefetch_related("roles"))
        # Один пайплайн на весь ростер вместо трёх round-trip'ов к Redis на
        # каждого участника (is_online + voice_channel + voice_flags).
        snapshot = presence.members_snapshot([m.user_id for m in memberships])
        data = []
        for m in memberships:
            u = m.user
            state = snapshot.get(str(u.id), {})
            eff_status = presence.effective_status(u, state.get("online", False))
            data.append({
                **UserSerializer(u).data,
                "online": eff_status != "offline",
                "status": eff_status,
                "voice_channel": state.get("voice_channel"),
                "muted": state.get("muted", False),
                "deafened": state.get("deafened", False),
                "sharing_screen": state.get("sharing_screen", False),
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
        if not roles.can_act_on_member(request.user, server, user_id):
            return Response(
                {"detail": "Нельзя менять роли участника не ниже вас."}, status=403)
        membership = get_object_or_404(Membership, server=server, user_id=user_id)
        role_ids = request.data.get("role_ids")
        if not isinstance(role_ids, list):
            return Response({"detail": "role_ids — список id ролей."}, status=400)
        # Роль по умолчанию действует на всех и не выдаётся персонально —
        # молча отбрасываем её, чтобы фронт не мог создать расхождение.
        valid = list(Role.objects.filter(
            server=server, id__in=role_ids, is_default=False))
        # Выдать можно только роль ниже своей — иначе manage_roles позволяло бы
        # назначить себе (или подельнику) роль администратора.
        too_high = [
            r.name for r in valid
            if not roles.can_manage_role(request.user, server, r.position)
        ]
        if too_high:
            return Response(
                {"detail": "Нельзя выдать роль не ниже вашей: "
                           + ", ".join(too_high) + "."},
                status=403,
            )
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
        if not roles.can_act_on_member(request.user, server, user_id):
            return Response(
                {"detail": "Нельзя выгнать участника не ниже вас."}, status=403)
        Membership.objects.filter(server=server, user_id=user_id).delete()
        _revoke_server_membership(server, user_id)
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
        denied = _require_role_hierarchy(request, server, serializer.validated_data)
        if denied:
            return denied
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
        denied = _require_role_hierarchy(
            request, server, serializer.validated_data, current_position=role.position)
        if denied:
            return denied
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
        if not roles.can_manage_role(request.user, server, role.position):
            return Response(
                {"detail": "Нельзя удалить роль не ниже вашей."}, status=403)
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
        _grant_server_membership(server, user_id)
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
        if not roles.can_act_on_member(request.user, server, target.id):
            return Response(
                {"detail": "Нельзя забанить участника не ниже вас."}, status=403)
        ban, _created = ServerBan.objects.get_or_create(
            server=server, user=target,
            defaults={
                "banned_by": request.user,
                "reason": str(request.data.get("reason") or "")[:300],
            },
        )
        Membership.objects.filter(server=server, user=target).delete()
        ServerJoinRequest.objects.filter(server=server, user=target).delete()
        _revoke_server_membership(server, target.id)
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


def _can_see_profile(user, target) -> bool:
    """Видит ли user профиль target: друзья, общий сервер или общая беседа —
    та же логика видимости, что уже используется для мини-профиля."""
    if are_friends(user, target):
        return True
    my_server_ids = Membership.objects.filter(user=user).values_list(
        "server_id", flat=True)
    if Membership.objects.filter(
        user=target, server_id__in=my_server_ids
    ).exists():
        return True
    my_conversation_ids = ConversationParticipant.objects.filter(
        user=user).values_list("conversation_id", flat=True)
    return ConversationParticipant.objects.filter(
        user=target, conversation_id__in=my_conversation_ids).exists()


class UserProfileCard(APIView):
    """GET /api/users/<id>/profile-card — тяжёлая часть чужого профиля.

    Гифка-баннер (до 4 МБ data-URL'ом) раньше ехала в UserSerializer, то есть
    в каждом сообщении и в каждой строке ростера. Нужна она ровно в одном
    месте — когда открыли карточку профиля, — поэтому и отдаётся отдельно и
    по требованию.
    """

    def get(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        if target.id != request.user.id and not _can_see_profile(request.user, target):
            return Response({"detail": "Нет доступа."}, status=403)
        return Response({
            "id": target.id,
            "banner_gradient": target.banner_gradient,
            "banner_image": target.banner_image,
        })


class ConversationListCreate(APIView):
    def get(self, request):
        conversations = list(
            Conversation.objects.filter(participants=request.user)
            .prefetch_related("participants")
            .order_by("-created_at")
            .distinct()
        )
        return Response(
            ConversationSerializer(
                conversations, many=True,
                context=conversation_context(request, conversations)).data
        )

    @transaction.atomic
    def post(self, request):
        kind = request.data.get("kind")
        raw_ids = request.data.get("user_ids") or []
        name = (request.data.get("name") or "").strip()

        if kind not in (Conversation.DM, Conversation.GROUP):
            return Response({"detail": "kind = dm | group."}, status=400)
        if not isinstance(raw_ids, list):
            return Response({"detail": "user_ids — список id."}, status=400)
        if len(raw_ids) > MAX_CONVERSATION_PARTICIPANTS:
            return Response(
                {"detail": f"Не больше {MAX_CONVERSATION_PARTICIPANTS} собеседников."},
                status=400,
            )
        try:
            user_ids = {int(uid) for uid in raw_ids if int(uid) != request.user.id}
        except (TypeError, ValueError):
            return Response({"detail": "user_ids должны быть числами."}, status=400)
        if not user_ids:
            return Response({"detail": "Нужен хотя бы один собеседник."}, status=400)

        # Раньше в ветке group список лишь проверялся на непустоту, а в
        # participant_ids уходили СЫРЫЕ id: несуществующий id ронял bulk_create
        # в IntegrityError, то есть отдавал 500 вместо внятного 400.
        targets = list(User.objects.filter(id__in=user_ids))
        if len(targets) != len(user_ids):
            return Response(
                {"detail": "Некоторых указанных пользователей не существует."},
                status=400)

        if kind == Conversation.DM:
            if len(user_ids) != 1:
                return Response({"detail": "Личка — ровно один собеседник."}, status=400)
            return self._create_dm(request, targets[0])
        return self._create_group(request, targets, name)

    def _create_dm(self, request, target):
        dm_key = Conversation.build_dm_key(request.user.id, target.id)
        existing = Conversation.objects.filter(
            kind=Conversation.DM, dm_key=dm_key).first()
        if existing is None:
            # Диалоги, заведённые до появления dm_key (см. миграцию 0006),
            # ключа не имеют — ищем их прежним способом, иначе поверх уже
            # идущей переписки завёлся бы второй пустой диалог.
            existing = (
                Conversation.objects.filter(
                    kind=Conversation.DM, dm_key="", participants=request.user)
                .filter(participants=target)
                .first()
            )
        if existing:
            return Response(
                ConversationSerializer(
                    existing,
                    context=conversation_context(request, existing)).data)

        if not can_dm(request.user, target):
            return Response(
                {"detail": "Этот пользователь не принимает личные сообщения от вас."},
                status=403,
            )
        try:
            # Вложенный atomic — это savepoint: без него IntegrityError
            # сломал бы всю внешнюю транзакцию и откатить его аккуратно было
            # бы нечем.
            with transaction.atomic():
                conversation = Conversation.objects.create(
                    kind=Conversation.DM, dm_key=dm_key)
        except IntegrityError:
            # Параллельный запрос (двойной клик, вторая вкладка) успел создать
            # тот же диалог — уникальный индекс поймал гонку, отдаём готовое.
            existing = Conversation.objects.get(kind=Conversation.DM, dm_key=dm_key)
            return Response(
                ConversationSerializer(
                    existing,
                    context=conversation_context(request, existing)).data)
        return self._add_participants(
            request, conversation, {request.user.id, target.id})

    def _create_group(self, request, targets, name):
        # Раньше в этой ветке не было НИ ОДНОЙ проверки: любой мог создать
        # группу с любыми user_id и сразу писать туда. Настройка «кто может
        # начать со мной личку» (dm_privacy) обходилась тривиально — достаточно
        # было прислать kind=group вместо kind=dm, а группа из двух человек
        # визуально неотличима от лички.
        blocked = [u.username for u in targets if not can_dm(request.user, u)]
        if blocked:
            return Response(
                {"detail": "Эти пользователи не принимают сообщения от вас: "
                           + ", ".join(blocked) + "."},
                status=403,
            )
        conversation = Conversation.objects.create(
            kind=Conversation.GROUP, name=name[:100])
        return self._add_participants(
            request, conversation, {request.user.id, *(u.id for u in targets)})

    def _add_participants(self, request, conversation, participant_ids):
        ConversationParticipant.objects.bulk_create([
            ConversationParticipant(conversation=conversation, user_id=uid)
            for uid in participant_ids
        ])
        data = ConversationSerializer(
            conversation, context=conversation_context(request, conversation)).data
        for uid in participant_ids:
            _notify_user(uid, {"op": "conversation_create", "conversation": data})
        return Response(data, status=201)


class ConversationDetail(APIView):
    """DELETE /api/conversations/<id> — выйти из беседы.

    Выхода не существовало вовсе: ConversationParticipant создавался в одном
    месте и не удалялся нигде. То есть из группы, в которую тебя добавили,
    деться было некуда — вычистить её можно было только через админку.
    """

    def delete(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        if not is_participant(request.user, conversation):
            return Response({"detail": "Нет доступа."}, status=403)

        ConversationParticipant.objects.filter(
            conversation=conversation, user=request.user).delete()
        # Оставшимся — убрать из ростера; вышедшему — закрыть беседу у себя и
        # отписаться от группы (см. GatewayConsumer.broadcast).
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"conversation_{conversation.id}",
            {"type": "broadcast", "payload": {
                "op": "conversation_participant_leave",
                "conversation_id": conversation.id,
                "user_id": request.user.id,
            }})
        _notify_user(request.user.id, {
            "op": "conversation_left",
            "conversation_id": conversation.id,
        })
        if not conversation.memberships.exists():
            conversation.delete()
        return Response(status=204)


class ConversationMessages(APIView):
    def get(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        if not is_participant(request.user, conversation):
            return Response({"detail": "Нет доступа."}, status=403)
        qs = conversation.messages.select_related(
            "author", "reply_to__author"
        ).prefetch_related("attachments", "reactions")
        messages = _paginate_messages(request, qs)
        return Response(ConversationMessageSerializer(messages, many=True).data)


class ConversationVoiceCredentials(APIView):
    def post(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        if not is_participant(request.user, conversation):
            return Response({"detail": "Нет доступа."}, status=403)
        # В личке/группе ролей нет — говорить и показывать экран может любой
        # участник беседы.
        ttl = sfu.DEFAULT_TTL
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
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        qs = channel.messages.select_related(
            "author", "reply_to__author"
        ).prefetch_related("attachments", "reactions")
        messages = _paginate_messages(request, qs)
        return Response(MessageSerializer(messages, many=True).data)


class ChannelVoiceMembers(APIView):
    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        return Response({"user_ids": list(presence.voice_member_ids(channel_id))})


class VoiceCredentials(APIView):
    def post(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        if channel.kind != Channel.VOICE:
            return Response({"detail": "Не голосовой канал."}, status=400)
        # speak проверяем именно здесь: без токена до SFU не дойти, так что
        # это и есть точка, где право «Говорить» становится настоящим.
        denied = _require_channel_access(request, channel, "speak")
        if denied:
            return denied
        # Медиа идёт через собственный SFU (mediasoup). Клиенту нужен адрес
        # сигналинга SFU и короткоживущий токен доступа (uid + room + права).
        ttl = sfu.DEFAULT_TTL
        perms = roles.permissions_for(request.user, channel.server)
        token = sfu.access_token(
            request.user.id, channel_id, request.user.username, ttl=ttl,
            can_speak=bool(perms.get("speak")),
            can_video=bool(perms.get("video")),
        )
        return Response({
            "sfu_url": settings.SFU_PUBLIC_URL,
            "sfu_token": token,
            "ttl": ttl,
        })


class AttachmentUpload(APIView):
    """POST /api/attachments (multipart, поле `file`) — загрузить вложение.

    Загрузка отделена от отправки сообщения намеренно. Файл уезжает обычным
    HTTP-запросом (виден прогресс, работает докачка/отмена, не блокируется
    WebSocket), а сообщение потом отправляется по gateway лёгким JSON'ом со
    списком id — см. chat.consumers._bind_attachments. Загнать 25 МБ в
    WS-фрейм означало бы забить единственный сокет клиента, по которому идут
    ещё и presence, и голосовая мета.

    Ручка не спрашивает, в какой канал файл предназначен: на этой стадии он
    ещё ничей. Правами он накрывается в момент привязки к сообщению —
    отправить его можно только туда, куда сам отправитель имеет право писать.
    """

    parser_classes = [MultiPartParser, FormParser]

    # Не привязанные ни к какому сообщению загрузки старше этого срока —
    # мусор: человек выбрал файл и передумал отправлять. Чистим лениво, при
    # следующей загрузке того же пользователя (см. _sweep_orphans) — заводить
    # ради этого cron/Celery в проекте, где их нет, несоразмерно.
    ORPHAN_TTL = timedelta(hours=6)

    def post(self, request):
        uploaded = request.FILES.get("file")
        if uploaded is None:
            return Response({"detail": "Нужен файл в поле file."}, status=400)
        if uploaded.size == 0:
            return Response({"detail": "Файл пустой."}, status=400)
        if uploaded.size > MAX_ATTACHMENT_BYTES:
            limit_mb = MAX_ATTACHMENT_BYTES // (1024 * 1024)
            return Response(
                {"detail": f"Файл слишком большой (макс. {limit_mb} МБ)."},
                status=400,
            )

        self._sweep_orphans(request.user)

        # Тип определяем по содержимому и «обеззараживаем» — см. chat.uploads,
        # там же про то, почему заголовку Content-Type верить нельзя.
        content_type, width, height = uploads.sniff(uploaded)
        attachment = Attachment(
            uploaded_by=request.user,
            original_name=(uploaded.name or "file")[:255],
            content_type=content_type,
            size=uploaded.size,
            width=width,
            height=height,
        )
        attachment.file.save(uploaded.name or "file", uploaded, save=False)
        attachment.save()
        return Response(AttachmentSerializer(attachment).data, status=201)

    def _sweep_orphans(self, user):
        # Поштучно, а не queryset.delete(): файлы с диска убирает post_delete
        # (см. chat.models._cleanup_attachment_file), а он для каждого объекта
        # всё равно вызывается отдельно — зато так очевидно, что чистится и
        # строка, и сам файл.
        cutoff = timezone.now() - self.ORPHAN_TTL
        stale = Attachment.objects.filter(
            uploaded_by=user,
            message__isnull=True,
            conversation_message__isnull=True,
            created_at__lt=cutoff,
        )
        for attachment in stale:
            attachment.delete()


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def config_view(request):
    return Response({"app_name": settings.APP_NAME})
