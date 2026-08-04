import json
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.db.models import Count, F, Max, Q
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

from . import emoji as emoji_keys, presence, roles, sfu, stickers as sticker_files, uploads
from .models import (
    Attachment, Channel, ChannelMemberSettings, Conversation, ConversationMessage,
    ConversationParticipant, FriendNickname, Membership, Message, ProfileNote, Role, Server,
    ServerBan, ServerEmoji, ServerInvite, ServerJoinRequest, Sticker, StickerPack,
    ChannelReadState, UserRelationState,
    MAX_ATTACHMENT_BYTES, MAX_EMOJI_BYTES, MAX_EMOJI_PER_SERVER,
    MAX_VOICE_MS, MAX_WAVEFORM_POINTS,
    MAX_STICKER_NAME_LEN, MAX_STICKER_PACK_NAME_LEN, MAX_STICKER_PACKS_PER_SERVER,
    MAX_STICKER_SOURCE_BYTES, MAX_STICKERS_PER_PACK, MIN_STICKER_NAME_LEN,
    _invite_code, dm_room,
)
from .permissions import (
    are_friends, blocked_user_ids, can_dm, can_see_channel, visible_channels,
)
from .serializers import (
    AttachmentSerializer, ChannelInviteSerializer, ChannelMemberSettingsSerializer,
    ChannelSerializer, ConversationMessageSerializer,
    ConversationSerializer, MembershipSettingsSerializer, MessageSerializer,
    RoleSerializer, ServerBanSerializer, ServerEmojiSerializer,
    ServerInviteLinkSerializer, ServerInviteSerializer,
    ServerJoinRequestSerializer, ServerSerializer, ServerUpdateSerializer,
    StickerPackSerializer, StickerSerializer, channel_member_settings_payload,
    membership_settings_payload,
)

User = get_user_model()


def is_member(user, server) -> bool:
    return Membership.objects.filter(user=user, server=server).exists()


def _require_any_permission(request, server, *permissions):
    """То же, что _require_permission, но достаточно ЛЮБОГО из прав. Нужно
    там, где широкое право включает в себя узкое: «Выгонять/одобрять/банить»
    (manage_members) само по себе даёт и бан, а ban_members — только его."""
    perms = roles.permissions_for(request.user, server)
    if any(perms.get(name) for name in permissions):
        return None
    return Response({"detail": "Недостаточно прав на сервере."}, status=403)


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
    # Приватный канал закрыт даже при view_channels — нужен явный допуск
    # (см. chat.permissions.can_see_channel).
    if not can_see_channel(request.user, channel, perms):
        return Response({"detail": "Нет доступа к каналу."}, status=403)
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
    """Контекст для ServerSerializer: request (нужен для my_permissions/
    my_settings) плюс заранее собранные состояния звонков всех голосовых
    каналов — одним пайплайном вместо двух обращений к Redis на каждый канал
    во время сериализации (см. ChannelSerializer._state)."""
    if isinstance(servers, Server):
        servers = [servers]
    all_channels = [channel for server in servers for channel in server.channels.all()]
    voice_channel_ids = [c.id for c in all_channels if c.kind == Channel.VOICE]
    my_memberships = {}
    channel_settings = {}
    if request.user and request.user.is_authenticated:
        from .models import ChannelMemberSettings

        # Одним запросом на весь список — без него my_settings делал бы
        # отдельный Membership.objects.filter(...) на каждый сервер
        # (см. ServerSerializer.get_my_settings).
        my_memberships = {
            m.server_id: m
            for m in Membership.objects.filter(
                user=request.user, server__in=servers)
        }
        # Тот же приём для ChannelSerializer.get_my_settings — иначе на КАЖДЫЙ
        # канал КАЖДОГО сервера в списке уходил бы свой запрос.
        channel_settings = {
            s.channel_id: s
            for s in ChannelMemberSettings.objects.filter(
                user=request.user, channel__in=all_channels)
        }
    return {
        "request": request,
        "call_states": presence.call_states(voice_channel_ids),
        "my_memberships": my_memberships,
        "channel_settings": channel_settings,
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
        # Своё участие в каждой беседе — оттуда сериализатор берёт личные
        # настройки (закрепление). Одним запросом, а не по строке на беседу.
        "my_memberships": {
            m.conversation_id: m
            for m in ConversationParticipant.objects.filter(
                user=request.user, conversation_id__in=ids)
        },
    }


def is_participant(user, conversation) -> bool:
    return ConversationParticipant.objects.filter(
        user=user, conversation=conversation).exists()


def _hide_blocked(user, qs):
    """Убрать из ленты сообщения тех, кого user заблокировал.

    Односторонне: у самого заблокированного ничего не меняется, он даже не
    узнаёт (см. chat.models.UserRelationState). Фильтруем в БД, а не на
    фронте, чтобы заблокированный текст вообще не покидал сервер — иначе
    «скрытие» держалось бы на честном слове клиента.

    Живые сообщения приходят мимо этой функции, через WebSocket — их
    отсеивает клиент по тому же списку (см. фронт useGatewayEvents).
    """
    blocked = blocked_user_ids(user)
    if not blocked:
        return qs
    return qs.exclude(author_id__in=blocked)


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


def _find_or_create_dm(user_a_id, user_b_id):
    """Найти личный диалог между двумя людьми или завести новый — без
    проверки can_dm: прямое приглашение на сервер, как и раньше, обходит
    настройки личных сообщений целиком (см. docstring ServerInvite),
    поэтому в отличие от ConversationListCreate._create_dm здесь её нет."""
    dm_key = Conversation.build_dm_key(user_a_id, user_b_id)
    conversation = Conversation.objects.filter(
        kind=Conversation.DM, dm_key=dm_key).first()
    if conversation is None:
        # Диалоги, заведённые до появления dm_key (см. миграцию 0006).
        conversation = (
            Conversation.objects.filter(
                kind=Conversation.DM, dm_key="", participants__id=user_a_id)
            .filter(participants__id=user_b_id)
            .first()
        )
    if conversation is not None:
        return conversation, False
    try:
        with transaction.atomic():
            conversation = Conversation.objects.create(
                kind=Conversation.DM, dm_key=dm_key)
            ConversationParticipant.objects.bulk_create([
                ConversationParticipant(conversation=conversation, user_id=user_a_id),
                ConversationParticipant(conversation=conversation, user_id=user_b_id),
            ])
        return conversation, True
    except IntegrityError:
        # Гонка (двойной клик "Пригласить") — та же строка, что и обычный
        # _create_dm, уже успела появиться.
        return Conversation.objects.get(kind=Conversation.DM, dm_key=dm_key), False


def _send_invite_message(request, target, invite):
    """Приглашение приходит адресату не отдельным списком, а карточкой
    сервера прямо в диалоге с пригласившим (см. web/src/components/
    ServerInviteCard.tsx) — заводит диалог при необходимости и рассылает
    сообщение так же, как обычная отправка по WebSocket (chat.consumers).
    """
    conversation, conv_created = _find_or_create_dm(request.user.id, target.id)
    message = ConversationMessage.objects.create(
        conversation=conversation, author=request.user, server_invite=invite)
    if conv_created:
        data = ConversationSerializer(
            conversation, context=conversation_context(request, conversation)).data
        for uid in (request.user.id, target.id):
            _notify_user(uid, {"op": "conversation_create", "conversation": data})
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"conversation_{conversation.id}",
        {"type": "broadcast", "payload": {
            "op": "dm_message_create",
            "message": ConversationMessageSerializer(message).data,
            "nonce": None,
        }})


def _broadcast_invite_message_update(invite):
    """После accept/decline карточка приглашения в переписке должна
    обновить свой статус у ОБОИХ участников живьём — тем же dm_message_update,
    что и обычное редактирование сообщения (см. chat.consumers._handle_dm_edit_message)."""
    message = invite.conversation_messages.select_related(
        "author", "reply_to__author", "server_invite__server"
    ).prefetch_related("attachments", "reactions").first()
    if message is None:
        return
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"conversation_{message.conversation_id}",
        {"type": "broadcast", "payload": {
            "op": "dm_message_update",
            "message": ConversationMessageSerializer(message).data,
        }})


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
        # Зеркало прав владельца — редактируемое им самим (см.
        # chat.roles.create_owner_role/owner_permissions).
        roles.create_owner_role(server)
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
                # Никнейм НА ЭТОМ СЕРВЕРЕ — виден всем участникам (в отличие
                # от приватного FriendNickname, см. chat.models.Membership).
                "server_nickname": m.nickname,
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


class ServerMemberNickname(APIView):
    """PATCH /api/servers/<id>/members/<user_id>/nickname {"nickname"} —
    никнейм участника НА ЭТОМ СЕРВЕРЕ (Membership.nickname).

    Своё имя меняет право change_nickname, чужое — manage_nicknames. Оба
    отдельные: «могу переименовать себя» и «могу переименовать кого угодно» —
    разные полномочия, и второе не подразумевает первое (роль-модератор может
    иметь право чинить чужие ники, но сама сидеть под настоящим).

    Не путать с приватным FriendNickname (см. UserNickname): тот односторонний
    и виден только тому, кто его поставил, этот — всему серверу."""

    def patch(self, request, server_id, user_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        own = user_id == request.user.id
        denied = _require_permission(
            request, server, "change_nickname" if own else "manage_nicknames")
        if denied:
            return denied
        # Иерархия ролей: переименовать чужого можно только строго ниже себя —
        # иначе manage_nicknames давало бы переименовать администратора.
        if not own and not roles.can_act_on_member(request.user, server, user_id):
            return Response(
                {"detail": "Нельзя менять никнейм участника не ниже вас."}, status=403)
        membership = get_object_or_404(Membership, server=server, user_id=user_id)
        nickname = str(request.data.get("nickname") or "").strip()[:100]
        membership.nickname = nickname
        membership.save(update_fields=["nickname"])
        # Ростер сервера у всех открыт прямо сейчас — без рассылки чужое имя
        # сменилось бы только у того, кто его правил, до перезахода остальных.
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"server_{server.id}", {"type": "broadcast", "payload": {
                "op": "server_member_nickname",
                "server_id": server.id,
                "user_id": user_id,
                "nickname": nickname,
            }})
        return Response({"user_id": user_id, "nickname": nickname})


class ServerRoles(APIView):
    """GET — список ролей сервера (виден всем участникам: фронту нужны имена
    и цвета), POST — создать роль (нужно manage_roles)."""

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        # Серверы, заведённые до появления редактируемой роли "Владелец" —
        # досоздаём её лениво здесь, а не разовой data-миграцией на все
        # существующие серверы разом (та же логика оправдания, что была бы у
        # такой миграции, просто размазанная по первому обращению каждого
        # сервера, а не по единому деплою).
        if not server.roles.filter(is_owner_role=True).exists():
            roles.create_owner_role(server)
        return Response(RoleSerializer(server.roles.all(), many=True).data)

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_roles")
        if denied:
            return denied
        serializer = RoleSerializer(data=request.data, context={"server": server})
        serializer.is_valid(raise_exception=True)
        denied = _require_role_hierarchy(request, server, serializer.validated_data)
        if denied:
            return denied
        # Роль по умолчанию и роль владельца — по одной на сервер и создаются
        # только вместе с ним/при первом ленивом обращении — через этот API
        # вторую такую не завести.
        serializer.save(server=server, is_default=False, is_owner_role=False)
        return Response(serializer.data, status=201)


class ServerRoleDetail(APIView):
    def patch(self, request, server_id, role_id):
        server = get_object_or_404(Server, id=server_id)
        role = get_object_or_404(Role, id=role_id, server=server)
        if role.is_owner_role:
            # Роль-зеркало прав владельца — не "выдаваемая", обычная
            # проверка manage_roles здесь неуместна: её редактирует только
            # сам владелец, своя же собственная (см. models.Role.is_owner_role).
            if request.user.id != server.owner_id:
                return Response(
                    {"detail": "Роль «Владелец» может редактировать только сам владелец."},
                    status=403)
        else:
            denied = _require_permission(request, server, "manage_roles")
            if denied:
                return denied
        serializer = RoleSerializer(
            role, data=request.data, partial=True, context={"server": server})
        serializer.is_valid(raise_exception=True)
        if not role.is_owner_role:
            denied = _require_role_hierarchy(
                request, server, serializer.validated_data, current_position=role.position)
            if denied:
                return denied
        # OWNER_LOCKED_PERMISSIONS форсим здесь ещё раз (страховка поверх
        # задизейбленных чекбоксов на фронте) — иначе прямой запрос в обход
        # UI мог бы снять владельцу доступ к его же настройкам/ролям навсегда,
        # заступиться некому — см. roles.owner_permissions.
        extra = {"is_default": role.is_default, "is_owner_role": role.is_owner_role}
        if role.is_owner_role:
            extra.update({name: True for name in roles.OWNER_LOCKED_PERMISSIONS})
        serializer.save(**extra)
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
        if role.is_owner_role:
            return Response(
                {"detail": "Роль «Владелец» удалить нельзя."}, status=400)
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
        denied = _require_any_permission(
            request, server, "manage_members", "ban_members")
        if denied:
            return denied
        qs = server.bans.select_related("user", "banned_by")
        return Response(ServerBanSerializer(qs, many=True).data)

    @transaction.atomic
    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_any_permission(
            request, server, "manage_members", "ban_members")
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
        denied = _require_any_permission(
            request, server, "manage_members", "ban_members")
        if denied:
            return denied
        ServerBan.objects.filter(server=server, user_id=user_id).delete()
        return Response(status=204)


class ServerLeave(APIView):
    """DELETE /api/servers/<id>/leave — выйти самому (без исключения/бана).

    Владелец выйти не может: сервер не может остаться без владельца, а
    передачи владения/удаления сервера в проекте нет — значит и «выйти» для
    него сейчас означает «сервер осиротеет», чего допускать нельзя. Кнопка
    в UI для владельца задизейблена по той же причине (см. web
    ServerContextMenu) — проверка здесь на случай прямого запроса мимо UI.
    """

    def delete(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        if server.owner_id == request.user.id:
            return Response(
                {"detail": "Владелец не может покинуть свой сервер."}, status=400)
        Membership.objects.filter(server=server, user=request.user).delete()
        _revoke_server_membership(server, request.user.id)
        return Response(status=204)


class MyServerSettings(APIView):
    """GET/PATCH /api/servers/<id>/settings — ЛИЧНЫЕ настройки уведомлений,
    заглушения и приватности запрашивающего на этом сервере.

    Не требует никакого права сверх членства: это не модерация сервера, а
    персональные предпочтения — каждый настраивает только себя (ровно как
    accounts.MeView для профиля).
    """

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        membership = get_object_or_404(Membership, server=server, user=request.user)
        return Response(membership_settings_payload(membership))

    # Верхняя граница на «заглушить на N минут» — месяц. Не техническое
    # ограничение, а защита от опечатки в духе mute_minutes=99999999,
    # которая на практике неотличима от muted_forever, но не показывает
    # честный статус «навсегда» в UI.
    MAX_MUTE_MINUTES = 60 * 24 * 30

    def patch(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        membership = get_object_or_404(Membership, server=server, user=request.user)
        data = request.data

        # Заглушение — это ДЕЙСТВИЕ (одно из трёх), а не поле для
        # MembershipSettingsSerializer — см. её докстринг.
        mute_ops = [k for k in ("mute_minutes", "mute_forever", "unmute") if k in data]
        if len(mute_ops) > 1:
            return Response(
                {"detail": "Укажите только одно действие с заглушением."}, status=400)
        if "mute_minutes" in data:
            try:
                minutes = int(data["mute_minutes"])
            except (TypeError, ValueError):
                return Response({"detail": "mute_minutes — целое число."}, status=400)
            if not 0 < minutes <= self.MAX_MUTE_MINUTES:
                return Response(
                    {"detail": "Недопустимая длительность заглушения."}, status=400)
            membership.muted_until = timezone.now() + timedelta(minutes=minutes)
            membership.muted_forever = False
        elif data.get("mute_forever"):
            membership.muted_forever = True
            membership.muted_until = None
        elif "unmute" in data:
            membership.muted_forever = False
            membership.muted_until = None

        serializer = MembershipSettingsSerializer(membership, data=data, partial=True)
        serializer.is_valid(raise_exception=True)
        # save() пишет ВСЕ поля инстанса, включая muted_until/muted_forever,
        # выставленные выше явно (это тот же объект membership, не копия).
        serializer.save()
        return Response(membership_settings_payload(membership))


class ServerInvites(APIView):
    """POST /api/servers/<id>/invites {"user_id", "channel_id"?} —
    пригласить конкретного человека напрямую, на сервер целиком или (если
    передан channel_id, см. правый клик по голосовому каналу →
    "Пригласить в голосовой чат") в конкретный канал. Нужно право
    create_invites — по умолчанию оно есть у всех (см.
    chat.roles.BASE_MEMBER_PERMISSIONS), так что поведение то же, что и
    раньше, но закрытый сервер теперь может его снять. Байпасит access_mode
    ЦЕЛИКОМ (в т.ч. «только по приглашению») — в этом и смысл приглашения;
    бан по-прежнему блокирует.

    Само приглашение адресат видит не отдельным списком, а карточкой сервера
    прямо в переписке с пригласившим — см. _send_invite_message."""

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        denied = _require_permission(request, server, "create_invites")
        if denied:
            return denied
        target = get_object_or_404(User, id=request.data.get("user_id"))
        if target.id == request.user.id:
            return Response({"detail": "Нельзя пригласить самого себя."}, status=400)
        channel = None
        channel_id = request.data.get("channel_id")
        if channel_id is not None:
            # Любой вид канала — раньше сюда пускали только голосовые
            # («Пригласить в голосовой чат»), но механика ничем не завязана
            # на голос: тот же ServerInvite.channel заводился и для текстовых
            # (см. правый клик по текстовому каналу → «Пригласить на канал»).
            channel = get_object_or_404(Channel, id=channel_id, server=server)
            if channel.invites_paused:
                return Response(
                    {"detail": "Приглашения в этот канал сейчас приостановлены."},
                    status=400)
        # Пригласить в КОНКРЕТНЫЙ канал можно и уже состоящего на сервере
        # друга (позвать в голосовой чат — не то же самое, что позвать на
        # сервер) — блокируем "уже на сервере" только для общего приглашения.
        if channel is None and is_member(target, server):
            return Response({"detail": "Этот пользователь уже на сервере."}, status=400)
        if ServerBan.objects.filter(server=server, user=target).exists():
            return Response({"detail": "Этот пользователь забанен на сервере."}, status=400)
        invite, created = ServerInvite.objects.get_or_create(
            server=server, invited_user=target, kind=ServerInvite.DIRECT,
            status=ServerInvite.PENDING, channel=channel,
            defaults={"created_by": request.user},
        )
        if created:
            _send_invite_message(request, target, invite)
        return Response(ServerInviteSerializer(invite).data, status=201 if created else 200)


class MyServerInvites(APIView):
    """GET /api/invites — личные приглашения, адресованные МНЕ и ещё не
    решённые. Ссылочные приглашения (kind=LINK) сюда не попадают — они не
    адресные. Решённые приглашения адресат видит в самой переписке
    (карточкой — см. ConversationServerInviteSerializer), не здесь."""

    def get(self, request):
        qs = ServerInvite.objects.filter(
            kind=ServerInvite.DIRECT, invited_user=request.user,
            status=ServerInvite.PENDING,
        ).select_related("server", "created_by")
        return Response(ServerInviteSerializer(qs, many=True).data)


class ServerInviteDecision(APIView):
    """POST — принять приглашение (сразу становишься участником, без
    рассмотрения владельцем — сам факт приглашения от участника это
    разрешение). DELETE — отклонить (приглашённым) или отозвать
    (пригласившим) — симметрично FriendRequestDecline.

    Приглашение не удаляется по решению (в отличие от прежнего поведения) —
    оно живёт карточкой в переписке (см. ConversationMessage.server_invite) и
    должно продолжать показывать там своё состояние."""

    def post(self, request, invite_id):
        invite = get_object_or_404(
            ServerInvite, id=invite_id, kind=ServerInvite.DIRECT,
            invited_user=request.user, status=ServerInvite.PENDING)
        server = invite.server
        if ServerBan.objects.filter(server=server, user=request.user).exists():
            invite.status = ServerInvite.DECLINED
            invite.save(update_fields=["status"])
            _broadcast_invite_message_update(invite)
            return Response({"detail": "Вы забанены на этом сервере."}, status=403)
        Membership.objects.get_or_create(user=request.user, server=server)
        invite.status = ServerInvite.ACCEPTED
        invite.save(update_fields=["status"])
        _grant_server_membership(server, request.user.id)
        _broadcast_invite_message_update(invite)
        data = ServerSerializer(server, context=server_context(request, server)).data
        data["invited_channel_id"] = invite.channel_id
        return Response(data)

    def delete(self, request, invite_id):
        invite = get_object_or_404(
            ServerInvite.objects.filter(
                Q(invited_user=request.user) | Q(created_by=request.user)),
            id=invite_id, kind=ServerInvite.DIRECT, status=ServerInvite.PENDING,
        )
        invite.status = ServerInvite.DECLINED
        invite.save(update_fields=["status"])
        _broadcast_invite_message_update(invite)
        return Response(status=204)


class ServerInviteLink(APIView):
    """GET /api/servers/<id>/invite-link?channel_id=<id>? — постоянная
    многоразовая ссылка, СВОЯ у каждого участника (created_by — часть
    lookup'а get_or_create, не только defaults): раньше первый же вызвавший
    эту ручку на сервере создавал ЕДИНУЮ ссылку на всех, и все остальные
    участники получали её же код. Без channel_id — ссылка сервера целиком,
    с channel_id (правый клик по голосовому каналу → "Копировать ссылку"/
    "Пригласить в голосовой чат") — своя отдельная ссылка на КАЖДЫЙ канал.
    Повторные запросы одного и того же участника отдают тот же код, а не
    плодят новые. uses — сколько раз по НЕЙ реально вступили (см.
    ServerInviteRedeem), видно и самому автору (ServerInviteModal), и
    модераторам списком (см. ServerInviteLinksList)."""

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        denied = _require_permission(request, server, "create_invites")
        if denied:
            return denied
        channel = None
        channel_id = request.query_params.get("channel_id")
        if channel_id is not None:
            # invites_paused здесь намеренно НЕ проверяется: ссылка — это
            # постоянный адрес канала, а не активное действие «пригласить»
            # (то останавливает только ServerInvites.post, см. там). Пауза
            # относится к рассылке личных приглашений, а не к уже
            # существующей/скопированной ссылке.
            channel = get_object_or_404(Channel, id=channel_id, server=server)
        invite, _created = ServerInvite.objects.get_or_create(
            server=server, kind=ServerInvite.LINK, channel=channel,
            created_by=request.user,
            defaults={"code": _invite_code()},
        )
        return Response({"code": invite.code, "uses": invite.uses})


class ServerInviteLinksList(APIView):
    """GET /api/servers/<id>/invite-links — модераторский список ВСЕХ
    пригласительных ссылок участников сервера (кто сколько людей привёл),
    требует manage_members — то же право, что и остальная работа со
    списком/составом участников (баны, кик, роли)."""

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_members")
        if denied:
            return denied
        invites = ServerInvite.objects.filter(
            server=server, kind=ServerInvite.LINK,
        ).select_related("created_by", "channel").order_by("-uses", "-created_at")
        return Response(ServerInviteLinkSerializer(invites, many=True).data)


class InvitePreview(APIView):
    """GET /api/invites/preview?code=<code> — предпросмотр ссылки БЕЗ
    вступления, только для приглашений в конкретный канал (см. правый клик
    → "Пригласить в голосовой чат"/"Копировать ссылку"): переход по такой
    ссылке показывает модалку-подтверждение (см. web/src/components/
    VoiceInviteJoinModal.tsx) вместо мгновенного входа, который у обычной
    серверной ссылки (ServerInviteRedeem) остаётся как был."""

    def get(self, request):
        code = (request.query_params.get("code") or "").strip()
        invite = ServerInvite.objects.filter(
            kind=ServerInvite.LINK, code=code, channel__isnull=False,
        ).select_related("server", "channel").first()
        if invite is None:
            return Response({"detail": "Ссылка недействительна."}, status=404)
        server = invite.server
        if ServerBan.objects.filter(server=server, user=request.user).exists():
            return Response({"detail": "Вы забанены на этом сервере."}, status=403)
        channel_data = {
            "id": invite.channel_id, "name": invite.channel.name,
            "kind": invite.channel.kind,
        }
        # Число «сейчас в канале» имеет смысл только для голоса — у
        # текстового канала нет такого понятия (участников канала как
        # таковых не существует, только участники сервера, которым он
        # виден).
        if invite.channel.kind == Channel.VOICE:
            channel_data["participant_count"] = len(
                presence.voice_member_ids(invite.channel_id))
        return Response({
            "server": {"id": server.id, "name": server.name, "icon": server.icon},
            "channel": channel_data,
            "already_member": is_member(request.user, server),
        })


class ServerInviteRedeem(APIView):
    """POST /api/invites/redeem {"code"} — войти на сервер (и, если ссылка
    была на конкретный канал, вернуть его id, чтобы фронт сразу подключил
    к голосу — см. AppShell обработку ?voiceInvite=).

    Обладание кодом — это и есть авторизация (см. ServerInvite docstring):
    access_mode сервера здесь не смотрим вовсе, только бан.
    """

    def post(self, request):
        code = (request.data.get("code") or "").strip()
        invite = ServerInvite.objects.filter(
            kind=ServerInvite.LINK, code=code).select_related("server").first()
        if invite is None:
            return Response({"detail": "Ссылка недействительна."}, status=404)
        server = invite.server
        if not is_member(request.user, server):
            if ServerBan.objects.filter(server=server, user=request.user).exists():
                return Response({"detail": "Вы забанены на этом сервере."}, status=403)
            Membership.objects.get_or_create(user=request.user, server=server)
            _grant_server_membership(server, request.user.id)
            # F(), а не invite.uses += 1 — иначе одновременные вступления по
            # одной и той же ссылке (два человека почти разом) теряли бы
            # инкременты друг друга (read-modify-write не атомарен без него).
            ServerInvite.objects.filter(id=invite.id).update(uses=F("uses") + 1)
        data = ServerSerializer(server, context=server_context(request, server)).data
        data["invited_channel_id"] = invite.channel_id
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
            "banner_color": target.banner_color,
            "bio": target.bio,
            "pronouns": target.pronouns,
            "custom_status": target.custom_status,
            "custom_status_emoji": target.custom_status_emoji,
            "date_joined": target.date_joined,
        })


class UserAvatarAnimation(APIView):
    """GET /api/users/<id>/avatar-anim — гифка анимированного аватара.

    Отдельной ручкой и по требованию, по той же причине, что и баннер (см.
    UserProfileCard): статичный аватар едет в каждом сообщении и каждой
    строке ростера, а гифка тяжелее его на порядки. Клиент знает, есть ли
    что грузить, по флагу avatar_animated в обычном профиле, и приходит сюда
    ровно тогда, когда анимацию надо показать — говорит в голосовом,
    навели на отправителя сообщения, открыли карточку профиля.

    downloadable — предпочтение владельца «можно ли скачивать мой аватар»
    (см. accounts.models.User.avatar_downloadable); по нему фронт решает,
    показывать ли кнопку скачивания. Барьера видимости здесь нет намеренно:
    ровно та же картинка (её кадр) и так приезжает всем, кто видит
    сообщение или ростер.
    """

    def get(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        return Response({
            "avatar_anim": target.avatar_anim,
            "downloadable": target.avatar_downloadable,
        })


class UserNote(APIView):
    """GET/PUT приватной заметки о другом пользователе (см.
    chat.models.ProfileNote) — как заметки в профиле Discord: видна и
    редактируется только автором, у target об этом никакого сигнала не
    уходит. Тот же барьер видимости, что и у самой карточки профиля
    (_can_see_profile) — оставить заметку тому, чей профиль не видишь,
    нельзя."""

    def get(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        if target.id != request.user.id and not _can_see_profile(request.user, target):
            return Response({"detail": "Нет доступа."}, status=403)
        note = ProfileNote.objects.filter(author=request.user, about=target).first()
        return Response({"text": note.text if note else ""})

    def put(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        if target.id != request.user.id and not _can_see_profile(request.user, target):
            return Response({"detail": "Нет доступа."}, status=403)
        text = (request.data.get("text") or "").strip()
        note, _ = ProfileNote.objects.update_or_create(
            author=request.user, about=target, defaults={"text": text})
        return Response({"text": note.text})


class MyNicknames(APIView):
    """GET /api/nicknames — все никнеймы, которые Я кому-то дал.

    Отдаётся одним списком на старте (как /api/relations), а не полем в
    каждом User: подменённое имя нужно КАЖДОМУ месту, где рисуется ник
    (список друзей, диалоги, шапка чата, лента), а UserSerializer едет в
    каждом сообщении — таскать в нём поле, которое почти всегда пустое,
    незачем. Клиент держит эту карту в сторе и подставляет сам (см.
    web/src/nicknames.ts).
    """

    def get(self, request):
        rows = FriendNickname.objects.filter(owner=request.user)
        return Response([
            {"user_id": r.about_id, "nickname": r.nickname} for r in rows
        ])


class UserNickname(APIView):
    """GET/PUT/DELETE /api/users/<id>/nickname — приватный никнейм для
    конкретного человека (см. chat.models.FriendNickname).

    Барьер видимости тот же, что у заметки и карточки профиля
    (_can_see_profile). Пустая строка в PUT равнозначна DELETE — так
    «стереть поле и сохранить» в диалоге ввода не создаёт пустую строку в
    базе.
    """

    def _target(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        if target.id == request.user.id:
            return None, Response({"detail": "Себе никнейм не ставят."}, status=400)
        if not _can_see_profile(request.user, target):
            return None, Response({"detail": "Нет доступа."}, status=403)
        return target, None

    def get(self, request, user_id):
        target, error = self._target(request, user_id)
        if error:
            return error
        row = FriendNickname.objects.filter(owner=request.user, about=target).first()
        return Response({"nickname": row.nickname if row else ""})

    def put(self, request, user_id):
        target, error = self._target(request, user_id)
        if error:
            return error
        nickname = (request.data.get("nickname") or "").strip()[:64]
        if not nickname:
            FriendNickname.objects.filter(owner=request.user, about=target).delete()
            return Response({"nickname": ""})
        FriendNickname.objects.update_or_create(
            owner=request.user, about=target, defaults={"nickname": nickname})
        return Response({"nickname": nickname})

    def delete(self, request, user_id):
        target, error = self._target(request, user_id)
        if error:
            return error
        FriendNickname.objects.filter(owner=request.user, about=target).delete()
        return Response({"nickname": ""})


class PresenceView(APIView):
    """GET /api/presence — онлайн-статус всех, кого я вижу вне серверов:
    друзей и участников моих диалогов/групп.

    Ростер сервера везёт свой статус сам (см. ServerMembers), а вот список
    друзей и диалогов раньше не знал про онлайн вообще — точке статуса на
    аватарке там было неоткуда взяться. Отдельная ручка, а не поле в
    /api/friends и /api/conversations: статус живёт в Redis и меняется
    независимо от них, клиенту он нужен ОДНОЙ картой user_id -> статус, в
    которую потом капают presence_update по WS (см. web/src/presence.ts).
    """

    def get(self, request):
        friend_ids = set(
            Friendship.objects.filter(status=Friendship.ACCEPTED).filter(
                Q(from_user=request.user) | Q(to_user=request.user)
            ).values_list("from_user_id", "to_user_id")
        )
        user_ids = {uid for pair in friend_ids for uid in pair}
        my_conversation_ids = ConversationParticipant.objects.filter(
            user=request.user).values_list("conversation_id", flat=True)
        user_ids.update(ConversationParticipant.objects.filter(
            conversation_id__in=my_conversation_ids
        ).values_list("user_id", flat=True))
        user_ids.discard(request.user.id)
        if not user_ids:
            return Response([])

        snapshot = presence.members_snapshot(user_ids)
        users = User.objects.filter(id__in=user_ids).only("id", "status")
        return Response([
            {
                "user_id": u.id,
                "status": presence.effective_status(
                    u, (snapshot.get(str(u.id)) or {}).get("online", False)),
            }
            for u in users
        ])


class ConversationListCreate(APIView):
    def get(self, request):
        # «Закрытые» (см. ConversationSettings) в списке не показываем —
        # участие и история при этом целы, беседа вернётся сама при новом
        # сообщении (см. chat.consumers._reopen_for_recipients).
        closed_ids = ConversationParticipant.objects.filter(
            user=request.user, closed=True).values_list("conversation_id", flat=True)
        conversations = list(
            Conversation.objects.filter(participants=request.user)
            .exclude(id__in=closed_ids)
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


class ConversationSettings(APIView):
    """PATCH /api/conversations/<id>/settings — личные настройки беседы у
    того, кто их меняет (см. chat.models.ConversationParticipant).

    Оба поля необязательны и меняются независимо:
      pinned — держать беседу вверху списка «Диалоги»;
      closed — убрать её из списка, не удаляя ни историю, ни участие
        (в отличие от DELETE выше — тот именно ВЫХОДИТ из беседы).
    """

    def patch(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        membership = ConversationParticipant.objects.filter(
            conversation=conversation, user=request.user).first()
        if membership is None:
            return Response({"detail": "Нет доступа."}, status=403)

        updated = []
        for field in ("pinned", "closed"):
            if field in request.data:
                setattr(membership, field, bool(request.data[field]))
                updated.append(field)
        if updated:
            membership.save(update_fields=updated)
        return Response({
            "pinned": membership.pinned,
            "closed": membership.closed,
        })


class MyRelations(APIView):
    """GET /api/relations — все, кого я игнорирую или заблокировал.

    Нужен клиенту на старте: REST-ленты сервер уже фильтрует сам
    (см. _hide_blocked), но живые сообщения приходят по WebSocket мимо этой
    фильтрации, и отсеивать их клиенту нужно по готовому списку — иначе
    пришлось бы спрашивать про каждого автора отдельно.
    """

    def get(self, request):
        states = UserRelationState.objects.filter(user=request.user).filter(
            Q(ignored=True) | Q(blocked=True))
        return Response([
            {"user_id": s.target_id, "ignored": s.ignored, "blocked": s.blocked}
            for s in states
        ])


class UserRelation(APIView):
    """GET/PUT /api/users/<id>/relation — игнор и блокировка конкретного
    человека, личные и односторонние (см. chat.models.UserRelationState).

    Никакого уведомления второй стороне не уходит намеренно: и «игнорирую»,
    и «заблокировал» — это про СВОЮ ленту и свои уведомления, знать об этом
    объекту не нужно (тот же принцип, что у приватной заметки — UserNote).
    """

    def get(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        state = UserRelationState.objects.filter(
            user=request.user, target=target).first()
        return Response({
            "ignored": bool(state and state.ignored),
            "blocked": bool(state and state.blocked),
        })

    def put(self, request, user_id):
        target = get_object_or_404(User, id=user_id)
        if target.id == request.user.id:
            return Response(
                {"detail": "Нельзя заблокировать самого себя."}, status=400)
        state, _ = UserRelationState.objects.get_or_create(
            user=request.user, target=target)
        for field in ("ignored", "blocked"):
            if field in request.data:
                setattr(state, field, bool(request.data[field]))
        state.save(update_fields=["ignored", "blocked", "updated_at"])
        return Response({"ignored": state.ignored, "blocked": state.blocked})


class ConversationMessages(APIView):
    def get(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        if not is_participant(request.user, conversation):
            return Response({"detail": "Нет доступа."}, status=403)
        qs = conversation.messages.select_related(
            "author", "reply_to__author", "server_invite__server"
        ).prefetch_related("attachments", "reactions")
        qs = _hide_blocked(request.user, qs)
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


# Потолок медленного режима — как в Discord: 6 часов. Больше — уже не
# «замедление», а фактическое закрытие канала на запись, для которого есть
# отдельное право send_messages.
MAX_SLOWMODE_SECONDS = 6 * 60 * 60


def _parse_slowmode(raw, kind):
    """(секунды|None, Response|None) — общий разбор slowmode_seconds для
    создания канала и его правки. None в первом элементе значит «поле не
    передали», а не «ноль»: у PATCH это разные вещи."""
    if raw is None:
        return None, None
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        return None, Response(
            {"detail": "slowmode_seconds — целое число секунд."}, status=400)
    if not 0 <= seconds <= MAX_SLOWMODE_SECONDS:
        return None, Response(
            {"detail": f"Медленный режим — от 0 до {MAX_SLOWMODE_SECONDS} секунд."},
            status=400)
    # Голосовому каналу медленный режим нечего ограничивать: сообщений в нём
    # нет, а молча сохранённое значение позже выглядело бы как работающая,
    # но ничего не делающая настройка.
    if seconds and kind != Channel.TEXT:
        return None, Response(
            {"detail": "Медленный режим — только для текстовых каналов."}, status=400)
    return seconds, None


def _channel_visible_user_ids(channel) -> list:
    """id участников сервера, которым виден этот (приватный) канал — для
    адресной рассылки события вместо общей группы сервера."""
    from .permissions import can_see_channel

    ids = []
    for membership in channel.server.memberships.select_related("user"):
        if can_see_channel(membership.user, channel):
            ids.append(membership.user_id)
    return ids


def _channel_broadcast_payload(channel_data: dict) -> dict:
    """Копия сериализованного канала для WS-рассылки ВСЕМ участникам — без
    личных my_settings того, чьё действие вызвало событие (создал/поправил/
    склонировал канал). Тот же объект уже уходит ему одному в самом ответе
    ручки (см. вызывающих ниже, там ChannelSerializer сериализуется С
    контекстом request) — а вот в общей рассылке чужие уведомления/заглушение
    для этого канала никому, кроме него самого, видны быть не должны, даже
    мельком в сыром кадре WebSocket. Получателя это не портит: свои
    my_settings он всё равно берёт из уже загруженного локального состояния,
    а не из этого события (см. web useGatewayEvents channel_update)."""
    copy = dict(channel_data)
    copy["my_settings"] = channel_member_settings_payload(None)
    return copy


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
        # Медленный режим и приватность задаются сразу при создании (см.
        # web/src/components/CreateChannelModal.tsx) — иначе новый канал жил
        # бы открытым ровно до того момента, как его успеют донастроить.
        slowmode, error = _parse_slowmode(request.data.get("slowmode_seconds"), kind)
        if error:
            return error
        position = server.channels.count()
        channel = Channel.objects.create(
            server=server, name=name, kind=kind, position=position,
            slowmode_seconds=slowmode or 0,
            is_private=bool(request.data.get("is_private")),
        )
        data = ChannelSerializer(channel, context={"request": request}).data
        # Живое обновление списка каналов у остальных участников сервера —
        # без этого им приходилось перезагружать страницу, чтобы увидеть
        # новый канал (тот же паттерн, что и voice_state_update).
        payload = {
            "op": "channel_create",
            "server_id": server_id,
            "channel": _channel_broadcast_payload(data),
        }
        channel_layer = get_channel_layer()
        if channel.is_private:
            # В группе сервера сидят ВСЕ его участники, поэтому приватный
            # канал рассылаем поимённо — иначе само событие (с названием
            # канала) утекло бы тем, кому его видеть нельзя.
            for user_id in _channel_visible_user_ids(channel):
                async_to_sync(channel_layer.group_send)(
                    f"user_{user_id}", {"type": "broadcast", "payload": payload})
        else:
            async_to_sync(channel_layer.group_send)(
                f"server_{server_id}", {"type": "broadcast", "payload": payload})
        return Response(data, status=201)


class ChannelDetail(APIView):
    """PATCH /api/channels/<id> {"name"?, "status"?, "slowmode_seconds"?,
    "is_spoiler"?, "age_restricted"?, "is_private"?, "allowed_role_ids"?,
    "allowed_user_ids"?, "invites_paused"?} — правый клик по каналу →
    «Настроить канал» (см. web/src/components/ChannelSettingsModal.tsx; часть
    полей когда-то редактировалась прямо в ChannelContextMenu, теперь только
    через модалку).

    is_spoiler и age_restricted — независимые поля, но на фронте это ОДИН
    radio-выбор «Видимость контента» (см. ChannelSettingsModal
    onSetVisibility) — взаимную исключаемость обеспечивает он, присылая оба
    флага разом; сюда они приходят уже готовой парой, отдельно проверять
    «не выставлены ли оба» не нужно.

    Персистентный Channel.status, а НЕ эфемерная тема звонка
    (presence.call_topic/voice_topic_update, chat.consumers
    ._handle_voice_topic_update) — та живёт только пока в голосовом канале
    кто-то есть, эта видна всегда, пока её явно не поменяют/не очистят
    (пустая строка); у текстовых каналов это же поле показывается как «тема
    канала» (см. Channel.status). kind/position сюда не входят — их сейчас
    нигде не редактируют после создания канала, расширять ручку ради них
    незачем, пока такой возможности не попросят отдельно."""

    def patch(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        server = channel.server
        denied = _require_permission(request, server, "manage_channels")
        if denied:
            return denied
        name = request.data.get("name")
        status_text = request.data.get("status")
        slowmode_raw = request.data.get("slowmode_seconds")
        is_spoiler = request.data.get("is_spoiler")
        age_restricted = request.data.get("age_restricted")
        is_private = request.data.get("is_private")
        allowed_role_ids = request.data.get("allowed_role_ids")
        allowed_user_ids = request.data.get("allowed_user_ids")
        invites_paused = request.data.get("invites_paused")
        if all(v is None for v in (
            name, status_text, slowmode_raw, is_spoiler, age_restricted,
            is_private, allowed_role_ids, allowed_user_ids, invites_paused,
        )):
            return Response({"detail": "Нечего менять."}, status=400)
        updated = []
        if name is not None:
            name = str(name).strip()
            if not name:
                return Response({"detail": "Нужно имя канала."}, status=400)
            channel.name = name[:100]
            updated.append("name")
        if status_text is not None:
            channel.status = str(status_text).strip()[:1024]
            updated.append("status")
        seconds, error = _parse_slowmode(slowmode_raw, channel.kind)
        if error:
            return error
        if seconds is not None:
            channel.slowmode_seconds = seconds
            updated.append("slowmode_seconds")
        if is_spoiler is not None:
            channel.is_spoiler = bool(is_spoiler)
            updated.append("is_spoiler")
        if age_restricted is not None:
            channel.age_restricted = bool(age_restricted)
            updated.append("age_restricted")
        if is_private is not None:
            channel.is_private = bool(is_private)
            updated.append("is_private")
        if invites_paused is not None:
            channel.invites_paused = bool(invites_paused)
            updated.append("invites_paused")
        if updated:
            channel.save(update_fields=updated)
        if allowed_role_ids is not None:
            if not isinstance(allowed_role_ids, list):
                return Response(
                    {"detail": "allowed_role_ids — список id ролей."}, status=400)
            # Только роли ЭТОГО сервера — иначе допуск можно было бы выдать
            # ссылкой на роль чужого (тот же приём, что у mentionable_by).
            channel.allowed_roles.set(
                Role.objects.filter(server=server, id__in=allowed_role_ids))
        if allowed_user_ids is not None:
            if not isinstance(allowed_user_ids, list):
                return Response(
                    {"detail": "allowed_user_ids — список id участников."}, status=400)
            # Только участники ЭТОГО сервера — персональный допуск чужому
            # человеку (который и так не увидит сервер) ничего не значит и
            # только засорял бы список.
            channel.allowed_users.set(
                User.objects.filter(
                    memberships__server=server, id__in=allowed_user_ids))
        data = ChannelSerializer(channel, context={"request": request}).data
        payload = {
            "op": "channel_update",
            "server_id": server.id,
            "channel": _channel_broadcast_payload(data),
        }
        channel_layer = get_channel_layer()
        if channel.is_private:
            # Приватный канал — поимённо тем, кому он виден (см. ChannelCreate).
            for user_id in _channel_visible_user_ids(channel):
                async_to_sync(channel_layer.group_send)(
                    f"user_{user_id}", {"type": "broadcast", "payload": payload})
        else:
            async_to_sync(channel_layer.group_send)(
                f"server_{server.id}", {"type": "broadcast", "payload": payload})
        return Response(data)

    def delete(self, request, channel_id):
        """DELETE /api/channels/<id> — правый клик по каналу → «Удалить
        канал» (см. web/src/components/ChannelContextMenu.tsx; фронт
        предупреждает о необратимости сам, отдельного подтверждения бэкенд
        не спрашивает — той же логике следуют удаление сервера/сообщения).

        Каскадом уносит сообщения, вложения, реакции, закрепления, курсор
        прочтения — всё, что ссылается на канал (см. related_name с
        on_delete=CASCADE у соответствующих моделей)."""
        channel = get_object_or_404(Channel, id=channel_id)
        server = channel.server
        denied = _require_permission(request, server, "manage_channels")
        if denied:
            return denied
        # Список видящих и приватность — ДО удаления: после него разбирать,
        # кому был открыт уже удалённый канал, будет не по чему (M2M-таблицы
        # уйдут вместе со строкой).
        is_private = channel.is_private
        visible_user_ids = _channel_visible_user_ids(channel) if is_private else None
        channel.delete()
        payload = {
            "op": "channel_delete", "server_id": server.id, "channel_id": channel_id,
        }
        channel_layer = get_channel_layer()
        if is_private:
            for user_id in visible_user_ids:
                async_to_sync(channel_layer.group_send)(
                    f"user_{user_id}", {"type": "broadcast", "payload": payload})
        else:
            async_to_sync(channel_layer.group_send)(
                f"server_{server.id}", {"type": "broadcast", "payload": payload})
        return Response(status=204)


def _hide_old_history(request, server, qs):
    """Режет выборку по праву read_message_history: без него участник видит
    только то, что пришло с момента ТЕКУЩЕГО входа в сеть (см.
    chat.presence.online_since) — ровно как в Discord.

    Пользователь офлайн (граница неизвестна — REST-запрос успел уйти раньше,
    чем поднялся WS) — отсчитываем от «сейчас»: показать лишнее хуже, чем
    показать пусто, а через мгновение WS всё равно донесёт живые сообщения.
    """
    if roles.has_permission(request.user, server, "read_message_history"):
        return qs
    since = presence.online_since(request.user.id)
    cutoff = (
        timezone.datetime.fromtimestamp(since, tz=timezone.get_current_timezone())
        if since is not None
        else timezone.now()
    )
    return qs.filter(created_at__gte=cutoff)


class ChannelMessages(APIView):
    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        qs = channel.messages.select_related(
            "author", "reply_to__author"
        ).prefetch_related("attachments", "reactions")
        qs = _hide_blocked(request.user, qs)
        qs = _hide_old_history(request, channel.server, qs)
        messages = _paginate_messages(request, qs)
        return Response(MessageSerializer(messages, many=True).data)


class ChannelMemberSettingsView(APIView):
    """GET/PATCH /api/channels/<id>/settings — ЛИЧНЫЕ настройки уведомлений и
    заглушения запрашивающего для ОДНОГО канала (правый клик → «Параметры
    уведомлений»/«Заглушить канал», см. chat.models.ChannelMemberSettings —
    там же почему «как на сервере» не совпадает по смыслу с дефолтом
    Membership).

    Не требует прав сверх доступа к каналу — как и MyServerSettings, это не
    модерация, а личные предпочтения (см. _require_channel_access).
    """

    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        found = ChannelMemberSettings.objects.filter(
            user=request.user, channel=channel).first()
        return Response(channel_member_settings_payload(found))

    # Та же граница, что у MyServerSettings.MAX_MUTE_MINUTES, и по тем же
    # причинам — защита от опечатки вида mute_minutes=99999999.
    MAX_MUTE_MINUTES = 60 * 24 * 30

    def patch(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        data = request.data

        # Заглушение — ДЕЙСТВИЕ (одно из трёх), а не поле сериализатора — та
        # же причина, что у MyServerSettings.patch (см. её докстринг).
        mute_ops = [k for k in ("mute_minutes", "mute_forever", "unmute") if k in data]
        if len(mute_ops) > 1:
            return Response(
                {"detail": "Укажите только одно действие с заглушением."}, status=400)

        settings_obj, _created = ChannelMemberSettings.objects.get_or_create(
            user=request.user, channel=channel)

        if "mute_minutes" in data:
            try:
                minutes = int(data["mute_minutes"])
            except (TypeError, ValueError):
                return Response({"detail": "mute_minutes — целое число."}, status=400)
            if not 0 < minutes <= self.MAX_MUTE_MINUTES:
                return Response(
                    {"detail": "Недопустимая длительность заглушения."}, status=400)
            settings_obj.muted_until = timezone.now() + timedelta(minutes=minutes)
            settings_obj.muted_forever = False
        elif data.get("mute_forever"):
            settings_obj.muted_forever = True
            settings_obj.muted_until = None
        elif "unmute" in data:
            settings_obj.muted_forever = False
            settings_obj.muted_until = None

        serializer = ChannelMemberSettingsSerializer(settings_obj, data=data, partial=True)
        serializer.is_valid(raise_exception=True)
        # save() пишет ВСЕ поля инстанса, включая muted_until/muted_forever,
        # выставленные выше явно (тот же приём, что у MyServerSettings.patch).
        serializer.save()
        return Response(channel_member_settings_payload(settings_obj))


class ChannelInvitesList(APIView):
    """GET /api/channels/<id>/invites — личные приглашения, отправленные
    ИМЕННО в этот канал, все статусы разом (правый клик → «Настроить канал» →
    Приглашения). PATCH {"invites_paused"} — временно остановить НОВЫЕ личные
    приглашения в канал (см. ServerInvites.post) — уже отправленные и решения
    по ним не трогает.

    Оба требуют manage_channels: список содержит других участников — это
    модераторская информация, а не личная (в отличие от ChannelMemberSettingsView)."""

    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_permission(request, channel.server, "manage_channels")
        if denied:
            return denied
        qs = ServerInvite.objects.filter(
            channel=channel, kind=ServerInvite.DIRECT,
        ).select_related("invited_user")
        return Response(ChannelInviteSerializer(qs, many=True).data)

    def patch(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_permission(request, channel.server, "manage_channels")
        if denied:
            return denied
        if "invites_paused" not in request.data:
            return Response({"detail": "Нечего менять."}, status=400)
        channel.invites_paused = bool(request.data["invites_paused"])
        channel.save(update_fields=["invites_paused"])
        return Response({"invites_paused": channel.invites_paused})


class ChannelClone(APIView):
    """POST /api/channels/<id>/clone — точная копия канала: название, вид,
    тема/статус, медленный режим, спойлер, приватность и допуски (роли +
    персонально разрешённые участники) — БЕЗ единого сообщения. В этом и
    смысл клонирования: настроенный «близнец» для новой темы, а не архив
    переписки под новым именем (правый клик → «Клонировать канал»)."""

    def post(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        server = channel.server
        denied = _require_permission(request, server, "manage_channels")
        if denied:
            return denied
        last_position = server.channels.aggregate(Max("position"))["position__max"]
        clone = Channel.objects.create(
            server=server,
            # (копия) — не «дай мне другое имя», а честный сигнал, что это
            # именно клон: два канала с одинаковым названием на глаз не
            # отличить друг от друга.
            name=f"{channel.name} (копия)"[:100],
            kind=channel.kind,
            position=(last_position or 0) + 1,
            status=channel.status,
            slowmode_seconds=channel.slowmode_seconds,
            is_spoiler=channel.is_spoiler,
            age_restricted=channel.age_restricted,
            is_private=channel.is_private,
        )
        clone.allowed_roles.set(channel.allowed_roles.all())
        clone.allowed_users.set(channel.allowed_users.all())
        data = ChannelSerializer(clone, context={"request": request}).data
        payload = {
            "op": "channel_create", "server_id": server.id,
            "channel": _channel_broadcast_payload(data),
        }
        channel_layer = get_channel_layer()
        if clone.is_private:
            for user_id in _channel_visible_user_ids(clone):
                async_to_sync(channel_layer.group_send)(
                    f"user_{user_id}", {"type": "broadcast", "payload": payload})
        else:
            async_to_sync(channel_layer.group_send)(
                f"server_{server.id}", {"type": "broadcast", "payload": payload})
        return Response(data, status=201)


class ChannelReadStateView(APIView):
    """GET — где я остановился в этом канале; POST {"message_id"?} —
    продвинуть курсор вперёд (без message_id — до самого свежего сообщения).

    Курсор двигается только ВПЕРЁД (max с уже сохранённым): открытые в
    нескольких вкладках/устройствах клиенты присылают отметки не по порядку
    (например, вкладка, простоявшая свёрнутой на старом сообщении, ответит
    позже вкладки, которая уже прочитала всё), и без max более старая отметка
    откатила бы курсор назад, заставив клиент при следующем заходе решить,
    что свежие сообщения снова непрочитаны.
    """

    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        state = ChannelReadState.objects.filter(
            user=request.user, channel=channel).first()
        return Response({
            "last_read_message_id": state.last_read_message_id if state else None,
        })

    def post(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied

        raw = request.data.get("message_id")
        if raw is None:
            # Без message_id — «прочитано всё, что есть сейчас».
            message_id = channel.messages.order_by("-id").values_list(
                "id", flat=True).first()
            if message_id is None:
                return Response({"last_read_message_id": None})
        else:
            try:
                message_id = int(raw)
            except (TypeError, ValueError):
                return Response(
                    {"detail": "message_id должен быть числом."}, status=400)

        state, _created = ChannelReadState.objects.get_or_create(
            user=request.user, channel=channel)
        if state.last_read_message_id is None or message_id > state.last_read_message_id:
            state.last_read_message_id = message_id
            state.save(update_fields=["last_read_message_id", "updated_at"])
        return Response({"last_read_message_id": state.last_read_message_id})


class ChannelPins(APIView):
    """Закреплённые сообщения канала — отдельной ручкой, а не флагом в общей
    ленте: закреплённое может быть сколь угодно далеко в истории, до которой
    постраничная лента (см. _paginate_messages) не доехала."""

    def get(self, request, channel_id):
        channel = get_object_or_404(Channel, id=channel_id)
        denied = _require_channel_access(request, channel)
        if denied:
            return denied
        qs = channel.messages.filter(pinned_at__isnull=False).select_related(
            "author", "reply_to__author"
        ).prefetch_related("attachments", "reactions").order_by("-pinned_at", "-id")
        qs = _hide_blocked(request.user, qs)
        # Закреп — та же история: без read_message_history старое закреплённое
        # сообщение осталось бы видно через эту ручку в обход основной ленты.
        qs = _hide_old_history(request, channel.server, qs)
        return Response(MessageSerializer(qs, many=True).data)


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
        # connect проверяем именно здесь: без токена до SFU не дойти, так что
        # это и есть точка, где право «Подключаться» становится настоящим.
        # speak тут НЕ требуется — он уезжает отдельным claim'ом ниже:
        # connect без speak это законный «слушатель», которого раньше просто
        # не пускали в канал вовсе.
        denied = _require_channel_access(request, channel, "connect")
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


def _broadcast_emoji_update(server):
    """Разослать участникам сервера актуальный набор его эмодзи.

    Целиком, а не «добавился такой-то»: набор небольшой (см.
    MAX_EMOJI_PER_SERVER), а инкрементальные события пришлось бы согласовывать
    с тем, что клиент мог пропустить их, пока был в оффлайне. Приводить всех к
    одному состоянию дешевле, чем чинить рассинхрон — тот же приём, что у
    ленты реакций (см. reactions_payload).
    """
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"server_{server.id}", {"type": "broadcast", "payload": {
            "op": "server_emoji",
            "server_id": server.id,
            "emoji": ServerEmojiSerializer(
                server.emoji.all(), many=True).data,
        }})


def _validate_emoji_name(raw, server, exclude_id=None):
    """(имя, None) либо (None, Response с ошибкой)."""
    name = (raw or "").strip()
    if not emoji_keys.NAME_RE.match(name):
        return None, Response(
            {"detail": "Имя эмодзи — от 2 до 32 символов: латиница, цифры, «_»."},
            status=400)
    taken = ServerEmoji.objects.filter(server=server, name=name)
    if exclude_id is not None:
        taken = taken.exclude(id=exclude_id)
    if taken.exists():
        return None, Response(
            {"detail": f"Эмодзи с именем «{name}» на сервере уже есть."},
            status=400)
    return name, None


class ServerEmojiList(APIView):
    """GET — эмодзи сервера (видны всем участникам), POST — загрузить новый.

    Загрузка идёт multipart'ом и требует права «Создавать средства выражения
    эмоций» (create_expressions). Полей два: `file` — сам эмодзи, и `static` —
    первый кадр, если `file` анимированный. Кадр вырезает КЛИЕНТ (см.
    web/src/gif.ts): у бэкенда нет ffmpeg, а Pillow пришлось бы учить
    склеивать дельта-кадры GIF вручную — при том, что клиент этот разбор уже
    умеет, он же его и показывает в редакторе.

    Если клиент кадр не прислал, эмодзи всё равно сохранится — просто будет
    анимироваться всегда. Отказывать из-за этого нельзя: браузер без
    WebCodecs (см. gif.ts, запасной путь) кадр отдать не всегда может.
    """

    parser_classes = [MultiPartParser, FormParser]

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        return Response(
            ServerEmojiSerializer(server.emoji.all(), many=True).data)

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "create_expressions")
        if denied:
            return denied

        if server.emoji.count() >= MAX_EMOJI_PER_SERVER:
            return Response(
                {"detail": f"На сервере уже {MAX_EMOJI_PER_SERVER} эмодзи — "
                           "удалите ненужные."},
                status=400)

        uploaded = request.FILES.get("file")
        if uploaded is None or uploaded.size == 0:
            return Response({"detail": "Нужен файл в поле file."}, status=400)
        if uploaded.size > MAX_EMOJI_BYTES:
            return Response(
                {"detail": f"Эмодзи слишком большой (макс. "
                           f"{MAX_EMOJI_BYTES // 1024} КБ)."},
                status=400)

        sniffed = uploads.sniff_emoji(uploaded)
        if sniffed is None:
            return Response(
                {"detail": "Подойдёт только PNG, GIF или WEBP."}, status=400)
        content_type, animated = sniffed

        name, denied = _validate_emoji_name(request.data.get("name"), server)
        if denied:
            return denied

        emoji = ServerEmoji(
            server=server, name=name, animated=animated,
            content_type=content_type, size=uploaded.size,
            created_by=request.user,
        )
        # Имя файла собирается из ОПОЗНАННОГО типа, а не из uploaded.name:
        # под /media/emoji/ файлы отдаёт nginx, и Content-Type он выбирает по
        # расширению — см. emoji_upload_to, там подробно, чем это грозит.
        emoji.file.save(
            f"emoji.{content_type.rpartition('/')[2]}", uploaded, save=False)

        static = request.FILES.get("static") if animated else None
        if static is not None and 0 < static.size <= MAX_EMOJI_BYTES:
            # Кадр приходит от клиента, то есть проверяется ровно так же, как
            # и всё остальное присланное: картинка по содержимому или ничего.
            static_sniffed = uploads.sniff_emoji(static)
            if static_sniffed and not static_sniffed[1]:
                emoji.static_file.save(
                    f"static.{static_sniffed[0].rpartition('/')[2]}",
                    static, save=False)

        emoji.save()
        _broadcast_emoji_update(server)
        return Response(ServerEmojiSerializer(emoji).data, status=201)


class ServerEmojiDetail(APIView):
    """PATCH — переименовать, DELETE — удалить. И то, и другое по
    manage_expressions, а НЕ по create_expressions: права разделены именно
    затем, чтобы можно было дать «пусть добавляет свои», не давая при этом
    «пусть удаляет чужие» (см. chat.roles.PERMISSION_FIELDS, там же подписи,
    которые видит владелец сервера)."""

    def patch(self, request, server_id, emoji_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_expressions")
        if denied:
            return denied
        emoji = get_object_or_404(ServerEmoji, id=emoji_id, server=server)
        name, denied = _validate_emoji_name(
            request.data.get("name"), server, exclude_id=emoji.id)
        if denied:
            return denied
        emoji.name = name
        emoji.save(update_fields=["name"])
        _broadcast_emoji_update(server)
        return Response(ServerEmojiSerializer(emoji).data)

    def delete(self, request, server_id, emoji_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_expressions")
        if denied:
            return denied
        emoji = get_object_or_404(ServerEmoji, id=emoji_id, server=server)
        # Реакции с этим ключом и токены в старых сообщениях остаются: чистить
        # их значило бы переписывать чужую переписку. Отрисовка такого «сироты»
        # уже предусмотрена — см. web MessageReactions.EmojiGlyph.
        emoji.delete()
        _broadcast_emoji_update(server)
        return Response(status=204)


class MyEmoji(APIView):
    """GET /api/emoji — все эмодзи, доступные мне: наборы всех моих серверов.

    Один запрос вместо похода за каждым сервером отдельно: клиенту этот список
    нужен целиком и сразу — из него строится и лента наборов в пикере, и
    отрисовка токенов в уже пришедших сообщениях.

    ?ids=1,2,3 — отдельный режим: метаданные конкретных эмодзи БЕЗ проверки
    членства. Он нужен для чтения, а не для отправки: в личку могли прислать
    эмодзи сервера, где меня нет, и без этого у меня на месте картинки был бы
    вечный квадрат-заглушка. Ограничивать чтение здесь бессмысленно — сам файл
    в /media/ и так отдаётся любому, у кого есть ссылка (см. emoji_upload_to);
    ограничивается ОТПРАВКА, и делает это chat.emoji.usable_ids.
    """

    # Сколько id можно спросить за раз. Клиент спрашивает ровно про то, что
    # встретил в видимых сообщениях, — этого с запасом хватает на экран.
    MAX_RESOLVE_IDS = 100

    def get(self, request):
        raw_ids = request.query_params.get("ids")
        if raw_ids:
            ids = []
            for chunk in raw_ids.split(",")[:self.MAX_RESOLVE_IDS]:
                chunk = chunk.strip()
                if chunk.isdigit():
                    ids.append(int(chunk))
            queryset = ServerEmoji.objects.filter(id__in=ids)
        else:
            queryset = ServerEmoji.objects.filter(
                server__memberships__user=request.user)
        queryset = queryset.select_related("server").order_by(
            "server_id", "name", "id")
        return Response(ServerEmojiSerializer(queryset, many=True).data)


# --- стикеры -----------------------------------------------------------------
# Устройство почти повторяет эмодзи (см. выше), с двумя отличиями по существу:
#
#   1. вкладка пикера — это НАБОР (StickerPack), а не сервер: у сервера их
#      бывает несколько тематических, а базовые наборы вообще ничьи;
#   2. файл не сохраняется как прислали — он приводится к webp/lottie/webm и
#      ужимается до лимита прямо здесь (chat.stickers.prepare).


def _sticker_packs_payload(server):
    return StickerPackSerializer(
        server.sticker_packs.prefetch_related("stickers"), many=True).data


def _broadcast_sticker_update(server):
    """Разослать участникам сервера актуальные наборы стикеров — целиком, по
    той же причине, что и у эмодзи (см. _broadcast_emoji_update)."""
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f"server_{server.id}", {"type": "broadcast", "payload": {
            "op": "server_stickers",
            "server_id": server.id,
            "packs": _sticker_packs_payload(server),
        }})


def _validate_sticker_name(raw):
    """(имя, None) либо (None, Response с ошибкой).

    Алфавит не ограничен, в отличие от эмодзи: имя стикера не попадает в токен
    внутри текста (там только id — см. chat.emoji.STICKER_TOKEN_RE), поэтому
    кириллица, пробелы и что угодно ещё разбор ничему не мешают. Убираются
    только угловые скобки — чтобы имя нельзя было выдать за токен в тех местах,
    где оно показывается рядом с текстом.
    """
    name = " ".join((raw or "").split()).replace("<", "").replace(">", "")
    if not (MIN_STICKER_NAME_LEN <= len(name) <= MAX_STICKER_NAME_LEN):
        return None, Response(
            {"detail": f"Название стикера — от {MIN_STICKER_NAME_LEN} до "
                       f"{MAX_STICKER_NAME_LEN} символов."},
            status=400)
    return name, None


class ServerStickerList(APIView):
    """GET — наборы стикеров сервера, POST — загрузить стикер.

    Загрузка идёт multipart'ом и требует того же права, что и эмодзи
    («Создавать средства выражения эмоций»): и то, и другое — средство
    выражения, разделять их правами значило бы плодить настройки на ровном
    месте. Поля: `file` — сам стикер, `name` — подпись, `pack` — название
    набора (необязательно; по умолчанию — название сервера).

    Первый кадр для анимации, в отличие от эмодзи, КЛИЕНТ не присылает: файл
    здесь всё равно перекодируется целиком, и вырезать кадр заодно дешевле,
    чем гонять его по сети (см. chat.stickers.prepare).
    """

    parser_classes = [MultiPartParser, FormParser]

    def get(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        if not is_member(request.user, server):
            return Response({"detail": "Вы не участник сервера."}, status=403)
        return Response(_sticker_packs_payload(server))

    def post(self, request, server_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "create_expressions")
        if denied:
            return denied

        uploaded = request.FILES.get("file")
        if uploaded is None or uploaded.size == 0:
            return Response({"detail": "Нужен файл в поле file."}, status=400)
        if uploaded.size > MAX_STICKER_SOURCE_BYTES:
            return Response(
                {"detail": f"Файл слишком большой (макс. "
                           f"{MAX_STICKER_SOURCE_BYTES // (1024 * 1024)} МБ до "
                           "обработки)."},
                status=400)

        name, denied = _validate_sticker_name(request.data.get("name"))
        if denied:
            return denied

        pack, denied = self._resolve_pack(request, server)
        if denied:
            return denied
        if pack.stickers.count() >= MAX_STICKERS_PER_PACK:
            return Response(
                {"detail": f"В наборе «{pack.name}» уже "
                           f"{MAX_STICKERS_PER_PACK} стикеров — заведите новый "
                           "набор или удалите ненужные."},
                status=400)

        uploaded.seek(0)
        try:
            prepared = sticker_files.prepare(uploaded.read())
        except sticker_files.StickerError as err:
            return Response({"detail": str(err)}, status=400)

        sticker = Sticker(
            pack=pack, name=name, format=prepared.format,
            animated=prepared.animated, content_type=prepared.content_type,
            size=len(prepared.data), created_by=request.user,
        )
        # Имя файла собирается из ОПОЗНАННОГО формата, а не из uploaded.name —
        # см. sticker_upload_to, там подробно, чем это грозит.
        extension = "json" if prepared.format == "lottie" else prepared.format
        sticker.file.save(
            f"sticker.{extension}", ContentFile(prepared.data), save=False)
        if prepared.static:
            sticker.static_file.save(
                "static.webp", ContentFile(prepared.static), save=False)
        sticker.save()
        _broadcast_sticker_update(server)
        return Response(StickerSerializer(sticker).data, status=201)

    def _resolve_pack(self, request, server):
        """(набор, None) либо (None, Response с ошибкой). Набор с таким именем
        либо находится, либо заводится — отдельной ручки «создать набор» нет:
        она всегда была бы обязательным первым шагом перед загрузкой и ничего
        бы к ней не добавляла."""
        raw = " ".join((request.data.get("pack") or "").split())
        name = raw[:MAX_STICKER_PACK_NAME_LEN] or server.name[:MAX_STICKER_PACK_NAME_LEN]
        existing = server.sticker_packs.filter(name=name).first()
        if existing:
            return existing, None
        if server.sticker_packs.count() >= MAX_STICKER_PACKS_PER_SERVER:
            return None, Response(
                {"detail": f"На сервере уже {MAX_STICKER_PACKS_PER_SERVER} "
                           "наборов стикеров."},
                status=400)
        return StickerPack.objects.create(
            server=server, name=name, created_by=request.user), None


class ServerStickerDetail(APIView):
    """PATCH — переименовать, DELETE — удалить. По manage_expressions, ровно
    как у эмодзи (см. ServerEmojiDetail)."""

    def patch(self, request, server_id, sticker_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_expressions")
        if denied:
            return denied
        sticker = get_object_or_404(
            Sticker, id=sticker_id, pack__server=server)
        name, denied = _validate_sticker_name(request.data.get("name"))
        if denied:
            return denied
        sticker.name = name
        sticker.save(update_fields=["name"])
        _broadcast_sticker_update(server)
        return Response(StickerSerializer(sticker).data)

    def delete(self, request, server_id, sticker_id):
        server = get_object_or_404(Server, id=server_id)
        denied = _require_permission(request, server, "manage_expressions")
        if denied:
            return denied
        sticker = get_object_or_404(
            Sticker, id=sticker_id, pack__server=server)
        pack = sticker.pack
        # Токены "<sticker:id>" в старых сообщениях остаются и превращаются в
        # заглушку — переписывать чужую переписку мы не беремся (та же логика,
        # что при удалении эмодзи).
        sticker.delete()
        # Опустевший набор уносим следом: вкладка, за которой ничего нет,
        # только занимала бы место в ленте пикера.
        if not pack.stickers.exists():
            pack.delete()
        _broadcast_sticker_update(server)
        return Response(status=204)


class MyStickers(APIView):
    """GET /api/stickers — все наборы, доступные мне: базовые плюс наборы моих
    серверов.

    ?ids=1,2,3 — метаданные конкретных стикеров БЕЗ проверки членства, для
    ЧТЕНИЯ: в личку могли прислать стикер сервера, где меня нет, и без этого у
    меня на его месте была бы вечная заглушка. Ограничивается ОТПРАВКА, и
    делает это chat.emoji.usable_sticker_ids — ровно как с эмодзи (см.
    MyEmoji, там же почему это не дыра).
    """

    MAX_RESOLVE_IDS = 100

    def get(self, request):
        raw_ids = request.query_params.get("ids")
        if raw_ids:
            ids = []
            for chunk in raw_ids.split(",")[:self.MAX_RESOLVE_IDS]:
                chunk = chunk.strip()
                if chunk.isdigit():
                    ids.append(int(chunk))
            return Response(StickerSerializer(
                Sticker.objects.filter(id__in=ids), many=True).data)

        packs = StickerPack.objects.filter(
            Q(server__isnull=True) | Q(server__memberships__user=request.user)
        ).distinct().prefetch_related("stickers").select_related("server")
        return Response(StickerPackSerializer(packs, many=True).data)


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

        voice = str(request.data.get("voice", "")).lower() in ("1", "true")
        if voice:
            # У голосового свой разбор: тип берётся по сигнатуре контейнера, а
            # не по расширению (его у записи из браузера нет вовсе), и
            # неопознанное отклоняется, а не превращается в «файл на
            # скачивание» — см. uploads.sniff_voice.
            content_type = uploads.sniff_voice(uploaded)
            if content_type is None:
                return Response(
                    {"detail": "Это не похоже на запись голоса."}, status=400)
            width = height = None
        else:
            # Тип определяем по содержимому и «обеззараживаем» — см.
            # chat.uploads, там же про то, почему заголовку Content-Type
            # верить нельзя.
            content_type, width, height = uploads.sniff(uploaded)

        attachment = Attachment(
            uploaded_by=request.user,
            original_name=(uploaded.name or "file")[:255],
            content_type=content_type,
            size=uploaded.size,
            width=width,
            height=height,
            voice=voice,
            duration_ms=self._read_duration(request.data) if voice else None,
            waveform=self._read_waveform(request.data) if voice else [],
        )
        attachment.file.save(uploaded.name or "file", uploaded, save=False)
        attachment.save()
        return Response(AttachmentSerializer(attachment).data, status=201)

    @staticmethod
    def _read_duration(data):
        """Длительность голосового в миллисекундах — или None.

        Значение приходит от клиента и ничем не подтверждается: у webm из
        MediaRecorder длительность в контейнере часто не проставлена вовсе, и
        считать её на сервере было бы нечем (декодера звука у нас нет).
        Поэтому оно не «правда», а подпись под дорожкой — и обрезается по
        MAX_VOICE_MS, чтобы не превратиться в «99:99» на ровном месте.
        """
        try:
            value = int(data.get("duration_ms") or 0)
        except (TypeError, ValueError):
            return None
        if value <= 0:
            return None
        return min(value, MAX_VOICE_MS)

    @staticmethod
    def _read_waveform(data):
        """Пики громкости 0..100 — то, что рисуется столбиками.

        Приходят строкой JSON (обычное поле multipart-формы). Всё, что не
        разобралось, — пустой список: дорожка тогда рисуется ровной, и это
        куда лучше, чем отказ принять уже записанное сообщение.
        """
        raw = data.get("waveform")
        if not raw:
            return []
        try:
            values = json.loads(raw)
        except (TypeError, ValueError):
            return []
        if not isinstance(values, list):
            return []
        peaks = []
        for value in values[:MAX_WAVEFORM_POINTS]:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            peaks.append(max(0, min(100, int(value))))
        return peaks

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


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def permissions_catalog_view(request):
    """Каталог прав для редактора ролей: название, пояснение, группа и флаг
    «ещё не работает». Отдаётся с бэка, а не хардкодится на клиенте, чтобы
    список прав жил ровно в одном месте (chat.roles.PERMISSION_FIELDS) —
    раньше подписи и порядок дублировались в ServerSettingsModal и разъезжались
    с бэком при каждом изменении."""
    return Response({
        "groups": [
            {"id": group_id, "title": title}
            for group_id, title in roles.PERMISSION_GROUPS
        ],
        "permissions": [
            {
                "name": name,
                "label": label,
                "group": group,
                "hint": hint,
                "upcoming": name in roles.UPCOMING_PERMISSIONS,
                "owner_locked": name in roles.OWNER_LOCKED_PERMISSIONS,
            }
            for name, label, group, hint in roles.PERMISSION_FIELDS
        ],
    })
