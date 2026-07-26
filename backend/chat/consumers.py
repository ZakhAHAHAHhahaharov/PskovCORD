"""
GatewayConsumer — единственный WebSocket на клиента (по образу Discord gateway).

Через него идут: realtime-сообщения, presence (online/offline) и voice-state
(кто вошёл/вышел из голосового канала). Клиент подключается с JWT в query:
    ws://host/ws/gateway?token=<access>

Операции клиент -> сервер (JSON, поле "op"):
    {"op": "send_message", "channel_id": <id>, "content": "...", "reply_to": <id|null>}
    {"op": "delete_message", "message_id": <id>}
    {"op": "edit_message", "message_id": <id>, "content": "..."}
    {"op": "voice_join",   "channel_id": <id>}
    {"op": "voice_leave"}
    {"op": "voice_mute_update", "muted": bool, "deafened": bool}
    {"op": "voice_screen_share_update", "sharing": bool}
    {"op": "voice_topic_update", "topic": "..."}
    {"op": "voice_disconnect_user", "user_id": <id>} — отключить участника от
     ЕГО текущего голосового канала (нужно право "manage_members", владельца
     сервера отключить нельзя).
    {"op": "voice_mute_vote_start", "target_user_id": <id>} — начать
     голосование за мут участника, который сейчас в ТОМ ЖЕ голосовом канале,
     что и отправитель (право не нужно — может любой участник канала).
    {"op": "voice_mute_vote_cast", "for": bool} — проголосовать в активном
     голосовании канала, в котором отправитель сейчас находится (сама цель
     голосования голосовать не может).
    {"op": "voice_request_screen_share", "target_user_id": <id>} — попросить
     участника того же голосового канала включить демонстрацию экрана
     (персональный тихий пинг, см. voice_screen_share_requested ниже).
    {"op": "set_status", "status": "online" | "dnd" | "invisible"}
    {"op": "ping"}  — хартбит, см. presence.heartbeat/chat.heartbeat_sweep

    {"op": "dm_send_message", "conversation_id": <id>, "content": "...", "reply_to": <id|null>}
    {"op": "dm_delete_message", "message_id": <id>}
    {"op": "dm_edit_message", "message_id": <id>, "content": "..."}
    {"op": "dm_voice_join", "conversation_id": <id>}
    (voice_leave/voice_mute_update/voice_screen_share_update — те же клиентские
     op'ы, что и для голосовых каналов серверов: presence не различает
     сервер/диалог, см. models.is_dm_room — консьюмер сам разбирает, куда
     разослать broadcast)

События сервер -> клиент:
    {"op": "ready", "user": {...}}
    {"op": "message_create", "message": {...}}
    {"op": "message_update", "message": {...}}
    {"op": "message_delete", "message_id": <id>, "channel_id": <id>}
    {"op": "presence_update", "user_id": <id>, "online": bool, "status": "online"|"dnd"|"offline"}
    {"op": "voice_state_update", "user_id": <id>, "channel_id": <id|null>}
    {"op": "voice_peers", "channel_id": <id>, "peer_ids": [<id>, ...],
     "peer_flags": {<id>: {"muted": bool, "deafened": bool, "sharing_screen": bool}, ...}}
    {"op": "voice_mute_update", "user_id": <id>, "muted": bool, "deafened": bool}
    {"op": "voice_screen_share_update", "user_id": <id>, "sharing": bool}
    {"op": "voice_kicked", "channel_id": <id>} — персонально тому, кого только
     что принудительно отключили от голосового канала (voice_disconnect_user).
    {"op": "voice_mute_vote_start", "channel_id": <id>, "target_user_id": <id>,
     "initiator_user_id": <id>, "ends_at": <float>} — новое голосование в
     канале, всем на сервере (клиент сам решает, показывать ли модалку, по
     тому, находится ли он сейчас в этом канале).
    {"op": "voice_mute_vote_result", "channel_id": <id>, "target_user_id": <id>,
     "muted": bool, "votes_for": <int>, "votes_against": <int>} — итог
     голосования (см. chat.mute_vote.resolve).
    {"op": "voice_forced_mute", "until": <float>} — персонально тому, кого
     только что замьютило голосование; клиент обязан заглушить свой микрофон
     и не давать размьютиться раньше "until" (unix-секунды).
    {"op": "voice_screen_share_requested", "channel_id": <id>,
     "from_user_id": <id>, "from_username": "..."} — персонально: кто-то из
     того же голосового канала просит включить демонстрацию экрана.
    {"op": "voice_call_state", "channel_id": <id>,
     "call_started_at": <float|null>, "topic": "..."|null}
    {"op": "profile_update", "user_id": <id>, "username": "...",
     "avatar_color": "#RRGGBB", "avatar_image": "data:image/...;base64,..."|""}

    {"op": "dm_message_create", "message": {...}}
    {"op": "dm_message_update", "message": {...}}
    {"op": "dm_message_delete", "message_id": <id>, "conversation_id": <id>}
    {"op": "dm_voice_state_update", "user_id": <id>, "conversation_id": <id>, "in_call": bool}
    {"op": "dm_voice_peers", "conversation_id": <id>, "peer_ids": [<id>, ...],
     "peer_flags": {...}}
    {"op": "conversation_create", "conversation": {...}} — новый диалог/группа
     (или существующий DM, отданный повторно из get-or-create) — рассылается
     персонально каждому участнику через user_{id} (см. chat.views); консьюмер
     сам доподписывает своё соединение на conversation_{id} при получении.
    {"op": "conversation_call_ring", "conversation_id": <id>, "caller": {...}}
     — кто-то начал звонок в диалоге/группе (был первым зашедшим — см.
     _handle_dm_voice_join), персонально всем ОСТАЛЬНЫМ участникам через
     user_{id}, а не в conversation_{id} — они могут не иметь этот диалог
     открытым прямо сейчас.
    {"op": "friend_request_create", "id": <id>, "from_user": {...}}
    {"op": "friend_request_accept", "id": <id>, "user": {...}}
     — оба лично адресатy через user_{id} (см. accounts/chat.views).

Персональная группа user_{id} — для событий адресованных конкретному
человеку, а не всем на сервере/в диалоге (заявка в друзья, новый диалог,
входящий звонок): участник мог не успеть подписаться ни на одну общую
группу к моменту события.

profile_update — смена ника и/или аватара (см. accounts.views.MeView.patch,
не через этот gateway — обычный REST PATCH /api/auth/me). Рассылается всем
серверам, где состоит пользователь, чтобы ростер/сообщения обновились без
перезагрузки страницы у остальных.

voice_mute_update — статус своего микрофона/наушников (мьют, дефен), который
клиент шлёт при каждом изменении, пока состоит в голосовом канале; сервер
запоминает его в presence (voice_flags) и рассылает всем на сервере, чтобы
у остальных участников канала загорался/гас значок мьюта прямо в списке.

voice_screen_share_update — аналогично, но для демонстрации экрана. Живёт в
presence (voice_flags.sharing_screen), рассылается ВСЕМ участникам сервера
(не только тем, кто сейчас в этом голосовом канале) — на этом флаге держится
красный бейдж «демка» и переход по клику на него, даже если кликающий сам
никуда не подключён.

voice_call_state — момент начала текущего разговора в канале и его статус
(topic). Живёт в presence, пока в канале хоть кто-то есть: появляется при
входе первого участника, стирается когда выходит последний. Ставить topic
может только тот, кто сейчас сам в этом канале (voice_topic_update без
target-канала — сервер сам берёт канал из presence отправителя).

delete_message — удалить сообщение может автор ИЛИ владелец сервера (админ).
edit_message — редактировать может ТОЛЬКО автор, даже владелец сервера не
может править чужие сообщения (может только удалить).

set_status — online/dnd/invisible, это ВЫБОР пользователя, а не факт его
онлайн-статуса; реальная видимость другим считается отдельно через
presence.effective_status (invisible всегда маскируется под offline).

Медиа голоса (аудио/видео) идёт НЕ через этот gateway, а через отдельный
SFU-сервис (mediasoup) — клиент открывает к нему свой WebRTC-транспорт по
токену из voice-credentials. Здесь остаётся только «мета» голоса: presence,
кто в каком канале (voice_state_update/voice_peers), флаги мьюта и call-state.
"""
import asyncio
import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from . import mute_vote, presence, roles
from .models import (
    Channel, ConversationMessage, ConversationParticipant,
    Membership, Message, dm_conversation_id, dm_room, is_dm_room,
)
from .serializers import ConversationMessageSerializer, MessageSerializer


class GatewayConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope.get("user")
        if not self.user or not self.user.is_authenticated:
            await self.close(code=4001)
            return

        self.uid = str(self.user.id)
        self.server_groups = []
        self.conversation_groups = []
        self.personal_group = f"user_{self.user.id}"

        await self.accept()

        for sid in await self._server_ids():
            group = f"server_{sid}"
            self.server_groups.append(group)
            await self.channel_layer.group_add(group, self.channel_name)

        await asyncio.to_thread(presence.user_connected, self.uid)
        await asyncio.to_thread(presence.heartbeat, self.uid)
        await self._broadcast_presence(True)

        await self._send({
            "op": "ready",
            "user": {"id": self.user.id, "username": self.user.username},
        })

        # Диалоги/группы и персональная группа — после presence/"ready", той же
        # очерёдностью, что и раньше (до этой фичи): лишний запрос к БД и
        # group_add здесь иначе откладывают _broadcast_presence(True) ровно
        # настолько, что она может прилететь ПОЗЖЕ следующего же сообщения от
        # другого сокета в том же server_-канале — это ломает тесты вида
        # "проверить, что сокет ничего не получил" (см. chat/tests.py
        # MessageOpsTests): _receive_until находит нужный op раньше и уже не
        # вычитывает запоздавший presence_update, который потом "протекает".
        for cid in await self._conversation_ids():
            group = f"conversation_{cid}"
            self.conversation_groups.append(group)
            await self.channel_layer.group_add(group, self.channel_name)

        await self.channel_layer.group_add(self.personal_group, self.channel_name)

    async def disconnect(self, code):
        user = getattr(self, "user", None)
        if not user or not user.is_authenticated:
            return

        prev_voice = await asyncio.to_thread(presence.voice_channel, self.uid)
        remaining = await asyncio.to_thread(presence.user_disconnected, self.uid)

        for group in getattr(self, "server_groups", []) + getattr(self, "conversation_groups", []):
            await self.channel_layer.group_discard(group, self.channel_name)
        if getattr(self, "personal_group", None):
            await self.channel_layer.group_discard(self.personal_group, self.channel_name)

        if remaining == 0:
            if prev_voice and is_dm_room(prev_voice):
                await self._broadcast_dm_voice(
                    self.user.id, dm_conversation_id(prev_voice), False)
            elif prev_voice:
                server_id = await self._channel_server(prev_voice)
                await self._broadcast_voice(self.user.id, None, server_id)
                await self._broadcast_call_state(prev_voice, server_id)
            await self._broadcast_presence(False)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data or "{}")
        except (ValueError, TypeError):
            return

        op = data.get("op")
        if op == "send_message":
            await self._handle_send(data)
        elif op == "delete_message":
            await self._handle_delete_message(data)
        elif op == "edit_message":
            await self._handle_edit_message(data)
        elif op == "voice_join":
            await self._handle_voice_join(data)
        elif op == "voice_leave":
            await self._handle_voice_leave()
        elif op == "voice_mute_update":
            await self._handle_voice_mute_update(data)
        elif op == "voice_screen_share_update":
            await self._handle_voice_screen_share_update(data)
        elif op == "voice_topic_update":
            await self._handle_voice_topic_update(data)
        elif op == "voice_disconnect_user":
            await self._handle_voice_disconnect_user(data)
        elif op == "voice_mute_vote_start":
            await self._handle_voice_mute_vote_start(data)
        elif op == "voice_mute_vote_cast":
            await self._handle_voice_mute_vote_cast(data)
        elif op == "voice_request_screen_share":
            await self._handle_voice_request_screen_share(data)
        elif op == "set_status":
            await self._handle_set_status(data)
        elif op == "dm_send_message":
            await self._handle_dm_send(data)
        elif op == "dm_delete_message":
            await self._handle_dm_delete_message(data)
        elif op == "dm_edit_message":
            await self._handle_dm_edit_message(data)
        elif op == "dm_voice_join":
            await self._handle_dm_voice_join(data)
        elif op == "ping":
            # Хартбит живости соединения — см. presence.heartbeat и
            # chat.heartbeat_sweep (страховка на случай, если WS оборвётся
            # без close-фрейма и обычный disconnect() не придёт).
            await asyncio.to_thread(presence.heartbeat, self.uid)

    # --- операции -----------------------------------------------------------
    async def _handle_send(self, data):
        channel_id = data.get("channel_id")
        content = (data.get("content") or "").strip()
        if not channel_id or not content:
            return
        result = await self._create_message(
            channel_id, content[:4000], data.get("reply_to"))
        if not result:
            return
        await self.channel_layer.group_send(
            f"server_{result['server_id']}",
            {"type": "broadcast", "payload": {
                "op": "message_create", "message": result["data"]}},
        )

    async def _handle_delete_message(self, data):
        message_id = data.get("message_id")
        if not message_id:
            return
        result = await self._delete_message(message_id)
        if not result:
            return
        await self.channel_layer.group_send(
            f"server_{result['server_id']}",
            {"type": "broadcast", "payload": {
                "op": "message_delete",
                "message_id": message_id,
                "channel_id": result["channel_id"],
            }},
        )

    async def _handle_edit_message(self, data):
        message_id = data.get("message_id")
        content = (data.get("content") or "").strip()
        if not message_id or not content:
            return
        result = await self._edit_message(message_id, content[:4000])
        if not result:
            return
        await self.channel_layer.group_send(
            f"server_{result['server_id']}",
            {"type": "broadcast", "payload": {
                "op": "message_update", "message": result["data"]}},
        )

    async def _handle_dm_send(self, data):
        conversation_id = data.get("conversation_id")
        content = (data.get("content") or "").strip()
        if not conversation_id or not content:
            return
        result = await self._create_dm_message(
            conversation_id, content[:4000], data.get("reply_to"))
        if not result:
            return
        await self.channel_layer.group_send(
            f"conversation_{conversation_id}",
            {"type": "broadcast", "payload": {
                "op": "dm_message_create", "message": result}},
        )

    async def _handle_dm_delete_message(self, data):
        message_id = data.get("message_id")
        if not message_id:
            return
        result = await self._delete_dm_message(message_id)
        if not result:
            return
        await self.channel_layer.group_send(
            f"conversation_{result['conversation_id']}",
            {"type": "broadcast", "payload": {
                "op": "dm_message_delete",
                "message_id": message_id,
                "conversation_id": result["conversation_id"],
            }},
        )

    async def _handle_dm_edit_message(self, data):
        message_id = data.get("message_id")
        content = (data.get("content") or "").strip()
        if not message_id or not content:
            return
        result = await self._edit_dm_message(message_id, content[:4000])
        if not result:
            return
        await self.channel_layer.group_send(
            f"conversation_{result['conversation_id']}",
            {"type": "broadcast", "payload": {
                "op": "dm_message_update", "message": result["data"]}},
        )

    async def _handle_voice_join(self, data):
        channel_id = data.get("channel_id")
        if not channel_id:
            return
        server_id = await self._voice_channel_server(channel_id)
        if not server_id:
            return
        peer_ids, emptied_room = await asyncio.to_thread(
            presence.join_voice, self.uid, channel_id)
        # Демонстрация экрана не переживает смену канала (WebRTC-сессия рвётся
        # и пересобирается заново) — presence.voice_flags этого сама не знает
        # (флаг живёт до explicit clear_voice), поэтому глушим его здесь явно
        # и рассылаем всем на сервере, иначе кто угодно увидит в новом канале
        # унаследованный из старого канала бейдж «демка», который тут же
        # погаснет — заметно как ложное включение/выключение одним кликом.
        await asyncio.to_thread(presence.set_screen_sharing, self.uid, False)
        await self.channel_layer.group_send(
            f"server_{server_id}",
            {"type": "broadcast", "payload": {
                "op": "voice_screen_share_update",
                "user_id": self.user.id,
                "sharing": False,
            }},
        )
        peer_flags = await asyncio.to_thread(
            presence.voice_members_flags, channel_id)
        await self._broadcast_voice(self.user.id, channel_id, server_id)
        await self._broadcast_call_state(channel_id, server_id)
        # Комната, которую мы только что покинули переключением, могла быть
        # либо голосовым каналом сервера, либо диалогом/группой (dm_room) —
        # presence этого не различает, ветвим здесь (см. models.is_dm_room).
        if emptied_room and is_dm_room(emptied_room):
            await self._broadcast_dm_voice(
                self.user.id, dm_conversation_id(emptied_room), False)
        elif emptied_room:
            await self._broadcast_call_state(emptied_room, server_id)
        await self._send({
            "op": "voice_peers",
            "channel_id": channel_id,
            "peer_ids": [int(p) for p in peer_ids],
            "peer_flags": {
                int(uid): flags for uid, flags in peer_flags.items()
                if uid != self.uid
            },
        })

    async def _handle_dm_voice_join(self, data):
        conversation_id = data.get("conversation_id")
        if not conversation_id:
            return
        ok = await self._is_conversation_participant(conversation_id)
        if not ok:
            return
        room = dm_room(conversation_id)
        peer_ids, emptied_room = await asyncio.to_thread(
            presence.join_voice, self.uid, room)
        peer_flags = await asyncio.to_thread(
            presence.voice_members_flags, room)
        await self._broadcast_dm_voice(self.user.id, conversation_id, True)
        if emptied_room and is_dm_room(emptied_room):
            await self._broadcast_dm_voice(
                self.user.id, dm_conversation_id(emptied_room), False)
        elif emptied_room:
            server_id = await self._channel_server(emptied_room)
            await self._broadcast_call_state(emptied_room, server_id)
        if not peer_ids:
            # Мы первые в комнате — звонок только начинается, разбудить
            # остальных участников звонком (см. models docstring dm_room).
            await self._ring_others(conversation_id)
        await self._send({
            "op": "dm_voice_peers",
            "conversation_id": conversation_id,
            "peer_ids": [int(p) for p in peer_ids],
            "peer_flags": {
                int(uid): flags for uid, flags in peer_flags.items()
                if uid != self.uid
            },
        })

    async def _ring_others(self, conversation_id):
        other_ids = await self._conversation_other_participant_ids(conversation_id)
        caller = {
            "id": self.user.id,
            "username": self.user.username,
            "avatar_color": self.user.avatar_color,
            "avatar_image": self.user.avatar_image,
        }
        for uid in other_ids:
            await self.channel_layer.group_send(
                f"user_{uid}", {"type": "broadcast", "payload": {
                    "op": "conversation_call_ring",
                    "conversation_id": conversation_id,
                    "caller": caller,
                }})

    async def _handle_set_status(self, data):
        value = data.get("status")
        if value not in (self.user.ONLINE, self.user.DND, self.user.INVISIBLE):
            return
        await self._save_status(value)
        # Мы точно online (шлём через живой сокет) — broadcast пересчитает
        # эффективный статус (invisible замаскируется под offline для других).
        await self._broadcast_presence(True)

    async def _handle_voice_leave(self):
        prev = await asyncio.to_thread(presence.clear_voice, self.uid)
        if not prev:
            return
        if is_dm_room(prev):
            await self._broadcast_dm_voice(self.user.id, dm_conversation_id(prev), False)
            return
        server_id = await self._channel_server(prev)
        await self._broadcast_voice(self.user.id, None, server_id)
        await self._broadcast_call_state(prev, server_id)

    async def _handle_voice_topic_update(self, data):
        topic = (data.get("topic") or "").strip()[:120]
        channel_id = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not channel_id or is_dm_room(channel_id):
            # Тема разговора — фича голосовых КАНАЛОВ сервера; в личке/группе её нет.
            return
        await asyncio.to_thread(presence.set_call_topic, channel_id, topic)
        server_id = await self._channel_server(channel_id)
        await self._broadcast_call_state(channel_id, server_id)

    async def _handle_voice_disconnect_user(self, data):
        target_user_id = data.get("user_id")
        if not target_user_id or int(target_user_id) == self.user.id:
            return
        target_room = await asyncio.to_thread(presence.voice_channel, str(target_user_id))
        if not target_room or is_dm_room(target_room):
            return
        server_id = await self._channel_server(target_room)
        if not server_id:
            return
        allowed = await self._can_manage_members(server_id, target_user_id)
        if not allowed:
            return
        prev = await asyncio.to_thread(presence.clear_voice, str(target_user_id))
        if not prev:
            return
        # Не переиспользуем _broadcast_voice — та берёт username/avatar_color
        # из self.user (годится только когда рассылка о САМОМ СЕБЕ); здесь
        # self.user — тот, кто кикает, а не тот, кого кикнули. Ростер и так
        # уже знает имя/аватар цели (она загружена через api.members()),
        # событие только должно сообщить, что voice_channel стал null.
        await self.channel_layer.group_send(
            f"server_{server_id}", {"type": "broadcast", "payload": {
                "op": "voice_state_update",
                "user_id": int(target_user_id),
                "channel_id": None,
                "server_id": server_id,
            }})
        await self._broadcast_call_state(prev, server_id)
        await self.channel_layer.group_send(
            f"user_{target_user_id}", {"type": "broadcast", "payload": {
                "op": "voice_kicked",
                "channel_id": int(prev),
            }})

    async def _handle_voice_mute_vote_start(self, data):
        target_user_id = data.get("target_user_id")
        if not target_user_id or int(target_user_id) == self.user.id:
            return
        channel_id, server_id = await self._own_voice_channel_server()
        if not channel_id:
            return
        member_ids = await asyncio.to_thread(presence.voice_member_ids, channel_id)
        if str(target_user_id) not in member_ids:
            return
        if not await self._target_not_owner(server_id, target_user_id):
            return
        started = await asyncio.to_thread(
            presence.start_mute_vote, channel_id, target_user_id, self.user.id,
            mute_vote.MUTE_VOTE_DURATION_S)
        if not started:
            return
        vote = await asyncio.to_thread(presence.active_mute_vote, channel_id)
        await self.channel_layer.group_send(
            f"server_{server_id}", {"type": "broadcast", "payload": {
                "op": "voice_mute_vote_start",
                "channel_id": int(channel_id),
                "target_user_id": int(target_user_id),
                "initiator_user_id": self.user.id,
                "ends_at": vote["ends_at"],
            }})

    async def _handle_voice_mute_vote_cast(self, data):
        for_ = bool(data.get("for"))
        channel_id, _server_id = await self._own_voice_channel_server()
        if not channel_id:
            return
        vote = await asyncio.to_thread(presence.active_mute_vote, channel_id)
        if not vote or str(self.user.id) == vote["target_uid"]:
            return
        ok = await asyncio.to_thread(
            presence.cast_mute_vote, channel_id, self.user.id, for_)
        if not ok:
            return
        eligible = await asyncio.to_thread(
            presence.mute_vote_eligible_ids, channel_id, vote["target_uid"])
        votes_for, votes_against = await asyncio.to_thread(
            presence.mute_vote_tally, channel_id)
        if (votes_for | votes_against) >= eligible:
            await database_sync_to_async(mute_vote.resolve)(
                channel_id, self.channel_layer)

    async def _handle_voice_request_screen_share(self, data):
        target_user_id = data.get("target_user_id")
        if not target_user_id or int(target_user_id) == self.user.id:
            return
        own_room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not own_room or is_dm_room(own_room):
            return
        target_room = await asyncio.to_thread(presence.voice_channel, str(target_user_id))
        if target_room != own_room:
            return
        await self.channel_layer.group_send(
            f"user_{target_user_id}", {"type": "broadcast", "payload": {
                "op": "voice_screen_share_requested",
                "channel_id": int(own_room),
                "from_user_id": self.user.id,
                "from_username": self.user.username,
            }})

    async def _own_voice_channel_server(self):
        """(channel_id, server_id) ТЕКУЩЕГО голосового канала СЕРВЕРА
        отправителя — (None, None), если он не в голосе или это диалог/группа
        (голосование за мут и его подсчёт — только для серверных каналов, там
        есть ростер с ролями/правами; звонок в личке/группе этого не имеет)."""
        room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not room or is_dm_room(room):
            return None, None
        server_id = await self._channel_server(room)
        if not server_id:
            return None, None
        return room, server_id

    @database_sync_to_async
    def _can_manage_members(self, server_id, target_user_id):
        from .models import Server
        server = Server.objects.filter(id=server_id).first()
        if not server or server.owner_id == int(target_user_id):
            return False
        return roles.has_permission(self.user, server, "manage_members")

    @database_sync_to_async
    def _target_not_owner(self, server_id, target_user_id):
        from .models import Server
        server = Server.objects.filter(id=server_id).first()
        return bool(server) and server.owner_id != int(target_user_id)

    async def _handle_voice_mute_update(self, data):
        muted = bool(data.get("muted"))
        deafened = bool(data.get("deafened"))
        room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not room:
            return
        await asyncio.to_thread(
            presence.set_voice_flags, self.uid, muted, deafened)
        payload = {
            "op": "voice_mute_update",
            "user_id": self.user.id,
            "muted": muted,
            "deafened": deafened,
        }
        await self._send_to_room_group(room, payload)

    async def _handle_voice_screen_share_update(self, data):
        sharing = bool(data.get("sharing"))
        room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not room:
            return
        await asyncio.to_thread(presence.set_screen_sharing, self.uid, sharing)
        payload = {
            "op": "voice_screen_share_update",
            "user_id": self.user.id,
            "sharing": sharing,
        }
        await self._send_to_room_group(room, payload)

    async def _send_to_room_group(self, room, payload):
        """room — то, что вернул presence.voice_channel: либо настоящий
        Channel.id (сервер), либо dm_room(conversation_id) (личка/группа).
        presence сам не различает — различаем здесь, при рассылке."""
        if is_dm_room(room):
            await self.channel_layer.group_send(
                f"conversation_{dm_conversation_id(room)}",
                {"type": "broadcast", "payload": payload})
            return
        server_id = await self._channel_server(room)
        if not server_id:
            return
        await self.channel_layer.group_send(
            f"server_{server_id}", {"type": "broadcast", "payload": payload})

    # --- рассылка -----------------------------------------------------------
    async def _broadcast_presence(self, online: bool):
        eff_status = presence.effective_status(self.user, online)
        payload = {
            "op": "presence_update",
            "user_id": self.user.id,
            "username": self.user.username,
            "avatar_color": self.user.avatar_color,
            "avatar_image": self.user.avatar_image,
            "online": eff_status != "offline",
            "status": eff_status,
        }
        for group in self.server_groups:
            await self.channel_layer.group_send(
                group, {"type": "broadcast", "payload": payload})

    async def _broadcast_voice(self, user_id, channel_id, server_id):
        if not server_id:
            return
        payload = {
            "op": "voice_state_update",
            "user_id": user_id,
            "username": self.user.username,
            "avatar_color": self.user.avatar_color,
            "avatar_image": self.user.avatar_image,
            "channel_id": channel_id,
            "server_id": server_id,
        }
        # Только участникам этого сервера.
        await self.channel_layer.group_send(
            f"server_{server_id}", {"type": "broadcast", "payload": payload})

    async def _broadcast_dm_voice(self, user_id, conversation_id, in_call: bool):
        """Аналог _broadcast_voice для диалога/группы. conversation_id — какого
        диалога касается событие (и куда слать) — ВСЕГДА конкретный, в отличие
        от _broadcast_voice(channel_id) он не бывает None: там channel_id=None
        обозначало "вышел", здесь для этого отдельный in_call=False, потому
        что клиенту иначе неоткуда узнать, из какого диалога кто-то вышел."""
        payload = {
            "op": "dm_voice_state_update",
            "user_id": user_id,
            "username": self.user.username,
            "avatar_color": self.user.avatar_color,
            "avatar_image": self.user.avatar_image,
            "conversation_id": conversation_id,
            "in_call": in_call,
        }
        await self.channel_layer.group_send(
            f"conversation_{conversation_id}",
            {"type": "broadcast", "payload": payload})

    async def _broadcast_call_state(self, channel_id, server_id):
        if not server_id:
            return
        state = await asyncio.to_thread(presence.call_state, channel_id)
        await self.channel_layer.group_send(
            f"server_{server_id}", {"type": "broadcast", "payload": {
                "op": "voice_call_state",
                "channel_id": int(channel_id),
                "call_started_at": state["call_started_at"],
                "topic": state["topic"],
            }})

    async def broadcast(self, event):
        """Обработчик group_send(type="broadcast")."""
        payload = event["payload"]
        if payload.get("op") == "conversation_create":
            # Новый диалог/группа создаётся REST-вьюхой (chat.views), не этим
            # консьюмером — уже открытое соединение ещё не подписано на
            # conversation_{id} (группа собиралась один раз в connect() из
            # БД). Доподписываемся прямо здесь, до пересылки клиенту, чтобы
            # следующие dm_message_create/dm_voice_state_update в этом
            # диалоге сразу доходили без переподключения.
            conversation_id = payload["conversation"]["id"]
            group = f"conversation_{conversation_id}"
            if group not in self.conversation_groups:
                self.conversation_groups.append(group)
                await self.channel_layer.group_add(group, self.channel_name)
        await self._send(payload)

    async def _send(self, obj):
        await self.send(text_data=json.dumps(obj))

    # --- БД (sync -> async) -------------------------------------------------
    @database_sync_to_async
    def _server_ids(self):
        return list(
            Membership.objects.filter(user=self.user).values_list(
                "server_id", flat=True)
        )

    @database_sync_to_async
    def _create_message(self, channel_id, content, reply_to_id=None):
        try:
            channel = Channel.objects.select_related("server").get(id=channel_id)
        except Channel.DoesNotExist:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        if not roles.has_permission(self.user, channel.server, "send_messages"):
            return None
        reply_to = None
        if reply_to_id:
            # Разрешаем отвечать только на сообщение из ЭТОГО ЖЕ канала —
            # иначе можно было бы подсунуть id из чужого канала.
            reply_to = Message.objects.filter(
                id=reply_to_id, channel_id=channel_id).first()
        msg = Message.objects.create(
            channel=channel, author=self.user, content=content, reply_to=reply_to)
        return {"server_id": channel.server_id, "data": MessageSerializer(msg).data}

    @database_sync_to_async
    def _delete_message(self, message_id):
        try:
            msg = Message.objects.select_related("channel__server").get(id=message_id)
        except Message.DoesNotExist:
            return None
        server = msg.channel.server
        if not Membership.objects.filter(user=self.user, server=server).exists():
            return None
        # Удалить может автор ИЛИ тот, кому роль даёт «Удаление сообщений»
        # (владельцу сервера chat.roles выдаёт все права безусловно).
        if msg.author_id != self.user.id and not roles.has_permission(
            self.user, server, "delete_messages"
        ):
            return None
        channel_id, server_id = msg.channel_id, server.id
        msg.delete()
        return {"channel_id": channel_id, "server_id": server_id}

    @database_sync_to_async
    def _edit_message(self, message_id, content):
        try:
            msg = Message.objects.select_related(
                "channel__server", "author", "reply_to__author").get(id=message_id)
        except Message.DoesNotExist:
            return None
        # Редактировать может ТОЛЬКО автор — владелец сервера не исключение.
        if msg.author_id != self.user.id:
            return None
        msg.content = content
        msg.edited_at = timezone.now()
        msg.save(update_fields=["content", "edited_at"])
        return {
            "server_id": msg.channel.server_id,
            "data": MessageSerializer(msg).data,
        }

    @database_sync_to_async
    def _voice_channel_server(self, channel_id):
        """server_id, если это голосовой канал и юзер — участник сервера, иначе None."""
        try:
            channel = Channel.objects.select_related("server").get(id=channel_id)
        except Channel.DoesNotExist:
            return None
        if channel.kind != Channel.VOICE:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        return channel.server_id

    @database_sync_to_async
    def _channel_server(self, channel_id):
        try:
            return Channel.objects.get(id=channel_id).server_id
        except Channel.DoesNotExist:
            return None

    @database_sync_to_async
    def _save_status(self, value):
        self.user.status = value
        self.user.save(update_fields=["status"])

    @database_sync_to_async
    def _conversation_ids(self):
        return list(
            ConversationParticipant.objects.filter(user=self.user).values_list(
                "conversation_id", flat=True)
        )

    @database_sync_to_async
    def _is_conversation_participant(self, conversation_id):
        return ConversationParticipant.objects.filter(
            user=self.user, conversation_id=conversation_id).exists()

    @database_sync_to_async
    def _conversation_other_participant_ids(self, conversation_id):
        return list(
            ConversationParticipant.objects.filter(conversation_id=conversation_id)
            .exclude(user=self.user).values_list("user_id", flat=True)
        )

    @database_sync_to_async
    def _create_dm_message(self, conversation_id, content, reply_to_id=None):
        if not ConversationParticipant.objects.filter(
            user=self.user, conversation_id=conversation_id
        ).exists():
            return None
        reply_to = None
        if reply_to_id:
            # Только сообщение из ЭТОГО ЖЕ диалога — как и в _create_message.
            reply_to = ConversationMessage.objects.filter(
                id=reply_to_id, conversation_id=conversation_id).first()
        msg = ConversationMessage.objects.create(
            conversation_id=conversation_id, author=self.user,
            content=content, reply_to=reply_to)
        return ConversationMessageSerializer(msg).data

    @database_sync_to_async
    def _delete_dm_message(self, message_id):
        try:
            msg = ConversationMessage.objects.get(id=message_id)
        except ConversationMessage.DoesNotExist:
            return None
        if not ConversationParticipant.objects.filter(
            user=self.user, conversation_id=msg.conversation_id
        ).exists():
            return None
        # В отличие от серверного канала — тут нет "владельца", удалить
        # может только автор (у диалога/группы нет модератора).
        if msg.author_id != self.user.id:
            return None
        conversation_id = msg.conversation_id
        msg.delete()
        return {"conversation_id": conversation_id}

    @database_sync_to_async
    def _edit_dm_message(self, message_id, content):
        try:
            msg = ConversationMessage.objects.select_related(
                "author", "reply_to__author").get(id=message_id)
        except ConversationMessage.DoesNotExist:
            return None
        if msg.author_id != self.user.id:
            return None
        msg.content = content
        msg.edited_at = timezone.now()
        msg.save(update_fields=["content", "edited_at"])
        return {
            "conversation_id": msg.conversation_id,
            "data": ConversationMessageSerializer(msg).data,
        }
