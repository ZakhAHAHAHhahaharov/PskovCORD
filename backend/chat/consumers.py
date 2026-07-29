"""
GatewayConsumer — единственный WebSocket на клиента (по образу Discord gateway).

Через него идут: realtime-сообщения, presence (online/offline) и voice-state
(кто вошёл/вышел из голосового канала). Клиент подключается с JWT в query:
    ws://host/ws/gateway?token=<access>

Операции клиент -> сервер (JSON, поле "op"):
    {"op": "send_message", "channel_id": <id>, "content": "...", "reply_to": <id|null>,
     "attachment_ids": ["<uuid>", ...], "nonce": "<строка клиента>"}
    {"op": "delete_message", "message_id": <id>}
    {"op": "edit_message", "message_id": <id>, "content": "..."}
    {"op": "add_reaction", "message_id": <id>, "emoji": "🔥"}
    {"op": "remove_reaction", "message_id": <id>, "emoji": "🔥"}
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
    {"op": "voice_wake_user", "target_user_id": <id>} — «Разбудить мальчика»:
     разбудить участника того же голосового канала, у которого СЕЙЧАС выключен
     микрофон или звук (иначе сервер молча игнорирует — см.
     _handle_voice_wake_user); в отличие от voice_request_screen_share это не
     тихий пинг, а нарочно противный звук на стороне адресата.
    {"op": "set_status", "status": "online" | "dnd" | "invisible"}
    {"op": "ping"}  — хартбит, см. presence.heartbeat/chat.heartbeat_sweep

    {"op": "dm_send_message", "conversation_id": <id>, "content": "...", "reply_to": <id|null>,
     "attachment_ids": ["<uuid>", ...], "nonce": "<строка клиента>"}
    {"op": "dm_delete_message", "message_id": <id>}
    {"op": "dm_edit_message", "message_id": <id>, "content": "..."}
    {"op": "dm_add_reaction", "message_id": <id>, "emoji": "🔥"}
    {"op": "dm_remove_reaction", "message_id": <id>, "emoji": "🔥"}
    {"op": "dm_voice_join", "conversation_id": <id>}
    (voice_leave/voice_mute_update/voice_screen_share_update — те же клиентские
     op'ы, что и для голосовых каналов серверов: presence не различает
     сервер/диалог, см. models.is_dm_room — консьюмер сам разбирает, куда
     разослать broadcast)

События сервер -> клиент:
    {"op": "ready", "user": {...}}
    {"op": "message_create", "message": {...}, "nonce": "<строка клиента>"|null}
    {"op": "message_update", "message": {...}}
    {"op": "message_delete", "message_id": <id>, "channel_id": <id>}
    {"op": "message_nack", "nonce": "<строка клиента>", "reason": "..."}
    {"op": "message_ack", "nonce": "<строка клиента>", "message_id": <id>} —
     только на ПОВТОРНУЮ попытку с уже известным nonce: сообщение создано
     прошлой попыткой, второе создавать нельзя, а клиенту нужно закрыть
     статус «отправляется». Обычная (первая) отправка подтверждается самим
     message_create с тем же nonce, отдельного ack не шлётся.
    {"op": "message_reactions", "message_id": <id>, "channel_id": <id>,
     "reactions": [{"emoji": "🔥", "count": <int>, "user_ids": [<id>, ...]}, ...]}
    {"op": "presence_update", "user_id": <id>, "online": bool, "status": "online"|"dnd"|"offline"}
    {"op": "voice_state_update", "user_id": <id>, "channel_id": <id|null>}
    {"op": "voice_peers", "channel_id": <id>, "peer_ids": [<id>, ...],
     "peer_flags": {<id>: {"muted": bool, "deafened": bool, "sharing_screen": bool}, ...}}
    {"op": "voice_mute_update", "user_id": <id>, "muted": bool, "deafened": bool}
    {"op": "voice_screen_share_update", "user_id": <id>, "sharing": bool}
    {"op": "voice_kicked", "channel_id": <id>} — персонально тому, кого только
     что принудительно отключили от голосового канала (voice_disconnect_user).
    {"op": "voice_kicked_other_device"} — персонально ОСТАЛЬНЫМ подключениям
     того же аккаунта (см. _kick_other_devices): голос только что начался на
     другом устройстве/вкладке, у себя (канал или диалог/группа — не важно,
     какой именно) нужно немедленно разорвать голос локально. Один аккаунт
     не может быть в голосе на двух устройствах разом ни при каких условиях.
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
    {"op": "voice_wake_requested", "channel_id": <id>, "from_user_id": <id>,
     "from_username": "..."} — персонально: кто-то из того же голосового
     канала «будит» нас (см. voice_wake_user выше) — клиент обязан
     проиграть звук независимо от собственного выключенного микрофона/звука.
    {"op": "voice_call_state", "channel_id": <id>,
     "call_started_at": <float|null>, "topic": "..."|null}
    {"op": "profile_update", "user_id": <id>, "username": "...",
     "avatar_color": "#RRGGBB", "avatar_image": "data:image/...;base64,..."|""}

    {"op": "dm_message_create", "message": {...}, "nonce": "<строка клиента>"|null}
    {"op": "dm_message_update", "message": {...}}
    {"op": "dm_message_delete", "message_id": <id>, "conversation_id": <id>}
    {"op": "dm_message_reactions", "message_id": <id>, "conversation_id": <id>,
     "reactions": [...]}  — та же форма, что и message_reactions
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
    {"op": "server_membership_granted", "server_id": <id>} — лично тому, кто
     только что вступил на сервер (или чью заявку одобрили): консьюмер
     доподписывает своё соединение на server_{id}, иначе realtime по этому
     серверу молчал бы до перезагрузки страницы.
    {"op": "server_membership_revoked", "server_id": <id>} — лично тому, кого
     выгнали/забанили: консьюмер отписывается от server_{id} и выходит из
     голосового канала этого сервера. Без этого исключённый продолжал читать
     весь чат сервера, пока сам не закроет вкладку (писать он уже не мог —
     проверки при отправке смотрят в Membership).

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

nonce — идентификатор ПОПЫТКИ отправки, придуманный клиентом. Он едет
обратно в message_create/dm_message_create и в message_nack, и решает две
задачи разом:

  * статус доставки. Клиент рисует своё сообщение сразу («отправляется») и
    ждёт эхо со своим nonce — только оно означает «доставлено». Без этого
    единственным подтверждением был бы факт, что ws.send() не бросил
    исключение, а он не значит ничего: сокет мог оборваться в тот же миг.
  * дедупликация при ретрае. Клиент переотправляет сообщение, не получив
    эха (см. web/src/outbox.ts), и без nonce повтор создавал бы второе
    сообщение — сервер узнаёт попытку по nonce и отдаёт уже созданное,
    ничего не дублируя.

Сам nonce нигде не хранится дольше окна дедупликации (см. _recent_nonces) —
это не идентификатор сообщения, а метка попытки.

attachment_ids — id уже ЗАГРУЖЕННЫХ файлов (POST /api/attachments, см.
chat.views.AttachmentUpload). По WebSocket едут только id: сокет у клиента
один, и через него же идут presence и голосовая мета — 25 МБ в одном фрейме
блокировали бы их все. Привязать можно только собственную загрузку, ещё не
привязанную ни к какому сообщению (chat.consumers._bind_attachments).

add_reaction/remove_reaction — поставить/снять свою реакцию. Ставить может
любой, кто ВИДИТ сообщение (для канала — участник сервера с view_channels,
для лички — участник беседы); отдельного права под это нет. Разных эмодзи на
одном сообщении не больше MAX_REACTIONS_PER_MESSAGE; ограничение на
сообщение, а не на человека — один пользователь волен поставить все 20 сам.
В ответ рассылается message_reactions с ПОЛНЫМ актуальным набором реакций
этого сообщения, а не дельтой: набор маленький, а дельты пришлось бы
применять по порядку, который в распределённой рассылке не гарантирован.

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
import logging
import uuid
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from django.db import transaction

from . import emoji as emoji_keys, mute_vote, presence, roles

logger = logging.getLogger(__name__)
from .models import (
    Attachment, Channel, ConversationMessage, ConversationParticipant,
    MAX_ATTACHMENTS_PER_MESSAGE, MAX_REACTIONS_PER_MESSAGE, Membership,
    Message, Reaction, dm_conversation_id, dm_room, is_dm_room,
)
from .serializers import (
    ConversationMessageSerializer, MessageSerializer, reactions_payload,
)

# Сколько недавних nonce'ов помнит соединение, чтобы узнать повторную попытку
# отправки (см. докстринг модуля). Ретрай приходит секунды спустя и почти
# всегда следующим же сообщением, так что глубина нужна символическая — но не
# единица: между исходной попыткой и её ретраем клиент мог успеть отправить
# что-то ещё.
NONCE_MEMORY = 50


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
        # Отличает ЭТО устройство/вкладку от других подключений того же
        # аккаунта в personal_group — см. _kick_other_devices: рассылка
        # "разорви голос" идёт всем подключениям аккаунта разом, это
        # соединение должно уметь узнать в ней самого себя и не кикнуть
        # само же себя, когда оно и есть инициатор.
        #
        # Берём device_id из query (см. gateway.tsx — стабильный per-вкладку
        # id в sessionStorage, переживает reconnect и StrictMode-ремаунт), а
        # не генерируем свежий uuid на каждое СОЕДИНЕНИЕ: иначе один и тот же
        # физический браузер/вкладка, на миг оставшийся подключённым ДВУМЯ
        # WS-сокетами разом (обрыв+реконнект, двойной mount в дев-режиме),
        # выглядел бы для этой проверки как два разных устройства и кикал бы
        # сам себя. Если клиент почему-то его не прислал — откатываемся на
        # случайный uuid: ключ уникален как раньше, просто без устойчивости
        # к такой гонке.
        query = parse_qs(self.scope.get("query_string", b"").decode())
        device_id = (query.get("device_id") or [None])[0]
        self.connection_id = device_id or uuid.uuid4().hex

        # nonce уже отправленных сообщений -> id созданного сообщения. Нужен,
        # чтобы ретрай (клиент не дождался эха и отправил повторно) не создал
        # второе сообщение — см. докстринг модуля. Живёт в памяти соединения:
        # ретрай приходит по тому же сокету секунды спустя, а после разрыва
        # клиент и так перечитывает историю по REST (см. AppShell, "ready").
        self._recent_nonces: dict[str, int] = {}

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
        # Аккаунт бывает в голосе только с ОДНОГО устройства разом (см.
        # _kick_other_devices) — поэтому именно ЭТО соединение должно выйти
        # из голоса при своём же обрыве, а не когда закроется последняя
        # вкладка аккаунта вообще: у пользователя мог быть открыт ещё один
        # таб без голоса, и раньше (remaining == 0 ниже) presence так и
        # висел бы "в канале" призраком, пока не закроется и он тоже.
        owns_voice = bool(prev_voice) and await asyncio.to_thread(
            presence.is_voice_owner, self.uid, self.connection_id)
        remaining = await asyncio.to_thread(presence.user_disconnected, self.uid)

        for group in getattr(self, "server_groups", []) + getattr(self, "conversation_groups", []):
            await self.channel_layer.group_discard(group, self.channel_name)
        if getattr(self, "personal_group", None):
            await self.channel_layer.group_discard(self.personal_group, self.channel_name)

        if owns_voice:
            # user_disconnected уже вызвал clear_voice сам, если это была
            # последняя вкладка аккаунта (remaining == 0) — здесь просто
            # гарантируем то же самое и для случая remaining > 0; повторный
            # clear_voice на уже пустом состоянии — no-op.
            await asyncio.to_thread(presence.clear_voice, self.uid)
            if is_dm_room(prev_voice):
                await self._broadcast_dm_voice(
                    self.user.id, dm_conversation_id(prev_voice), False)
            else:
                server_id = await self._channel_server(prev_voice)
                await self._broadcast_voice(self.user.id, None, server_id)
                await self._broadcast_call_state(prev_voice, server_id)

        if remaining == 0:
            await self._broadcast_presence(False)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data or "{}")
        except (ValueError, TypeError):
            return

        op = data.get("op")
        # Один необработанный exception в конкретной операции раньше ронял
        # WHOLE WS-соединение целиком (Channels не ловит исключения из
        # receive() сам, ASGI-сервер закрывает сокет) — с клиента это
        # выглядело как "ничего не произошло": авто-реконнект тут же поднимал
        # новый сокет молча, без видимой ошибки, а сама операция (например,
        # delete_message) просто терялась. Теперь падение одной операции не
        # рвёт соединение целиком, а падение хотя бы попадает в лог.
        try:
            if op == "send_message":
                await self._handle_send(data)
            elif op == "delete_message":
                await self._handle_delete_message(data)
            elif op == "edit_message":
                await self._handle_edit_message(data)
            elif op == "add_reaction":
                await self._handle_reaction(data, add=True, dm=False)
            elif op == "remove_reaction":
                await self._handle_reaction(data, add=False, dm=False)
            elif op == "dm_add_reaction":
                await self._handle_reaction(data, add=True, dm=True)
            elif op == "dm_remove_reaction":
                await self._handle_reaction(data, add=False, dm=True)
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
            elif op == "voice_wake_user":
                await self._handle_voice_wake_user(data)
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
                restored = await asyncio.to_thread(presence.heartbeat, self.uid)
                if restored:
                    # Sweep успел счесть нас призраком (пинг задержался дольше
                    # HEARTBEAT_TTL — спящая вкладка, длинный сетевой провал),
                    # хотя сокет жив. Возвращаем себя в онлайн для остальных:
                    # иначе для них мы так и остались бы офлайн навсегда.
                    await self._broadcast_presence(True)
        except Exception:
            logger.exception("gateway op %r failed (user %s)", op, getattr(self, "uid", None))

    # --- операции -----------------------------------------------------------
    def _read_nonce(self, data):
        """nonce как его прислал клиент — строка ограниченной длины или None.

        Тип проверяем: значение уходит ключом в словарь и обратно в JSON, и
        принимать сюда что угодно (список, объект) незачем.
        """
        nonce = data.get("nonce")
        if not isinstance(nonce, str) or not nonce:
            return None
        return nonce[:64]

    def _read_attachment_ids(self, data):
        raw = data.get("attachment_ids")
        if not isinstance(raw, list):
            return []
        return [str(item) for item in raw[:MAX_ATTACHMENTS_PER_MESSAGE]]

    def _remember_nonce(self, nonce, message_id):
        if not nonce:
            return
        self._recent_nonces[nonce] = message_id
        while len(self._recent_nonces) > NONCE_MEMORY:
            # dict в Python помнит порядок вставки — самый старый идёт первым.
            self._recent_nonces.pop(next(iter(self._recent_nonces)))

    async def _nack(self, nonce, reason):
        """Сказать отправителю, что сообщение НЕ создано.

        Без этого клиенту оставалось бы только ждать таймаута: раньше любая
        неудачная отправка (нет прав, канала не существует) молча ничего не
        делала, и сообщение навсегда зависало в состоянии «отправляется».
        """
        if not nonce:
            return
        await self._send({"op": "message_nack", "nonce": nonce, "reason": reason})

    async def _handle_send(self, data):
        channel_id = data.get("channel_id")
        content = (data.get("content") or "").strip()
        attachment_ids = self._read_attachment_ids(data)
        nonce = self._read_nonce(data)
        if not channel_id:
            await self._nack(nonce, "Канал не указан.")
            return
        # Пустое сообщение без вложений отправлять нечего, но сообщение из
        # одних вложений — нормально (см. Message.content).
        if not content and not attachment_ids:
            await self._nack(nonce, "Пустое сообщение.")
            return
        if nonce and nonce in self._recent_nonces:
            # Ретрай уже доставленного: сообщение создано, эхо просто не
            # дошло. Повторяем ответ, ничего не создавая заново.
            await self._send({
                "op": "message_ack",
                "nonce": nonce,
                "message_id": self._recent_nonces[nonce],
            })
            return
        result = await self._create_message(
            channel_id, content[:4000], data.get("reply_to"), attachment_ids)
        if not result:
            await self._nack(nonce, "Нет доступа к каналу.")
            return
        self._remember_nonce(nonce, result["data"]["id"])
        await self.channel_layer.group_send(
            f"server_{result['server_id']}",
            {"type": "broadcast", "payload": {
                "op": "message_create", "message": result["data"],
                # nonce уходит всем, но нужен только автору — остальные его
                # игнорируют (см. web/src/outbox.ts). Отдельным личным
                # событием его слать нельзя: тогда автор получал бы «создано»
                # и «доставлено» двумя гонящимися сообщениями.
                "nonce": nonce,
            }},
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
        """Полный аналог _handle_send для лички/группы — см. комментарии там."""
        conversation_id = data.get("conversation_id")
        content = (data.get("content") or "").strip()
        attachment_ids = self._read_attachment_ids(data)
        nonce = self._read_nonce(data)
        if not conversation_id:
            await self._nack(nonce, "Диалог не указан.")
            return
        if not content and not attachment_ids:
            await self._nack(nonce, "Пустое сообщение.")
            return
        if nonce and nonce in self._recent_nonces:
            await self._send({
                "op": "message_ack",
                "nonce": nonce,
                "message_id": self._recent_nonces[nonce],
            })
            return
        result = await self._create_dm_message(
            conversation_id, content[:4000], data.get("reply_to"), attachment_ids)
        if not result:
            await self._nack(nonce, "Нет доступа к диалогу.")
            return
        self._remember_nonce(nonce, result["id"])
        await self.channel_layer.group_send(
            f"conversation_{conversation_id}",
            {"type": "broadcast", "payload": {
                "op": "dm_message_create", "message": result, "nonce": nonce}},
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

    async def _handle_reaction(self, data, add: bool, dm: bool):
        """Поставить/снять свою реакцию — общий обработчик для четырёх оп'ов.

        Канал и личка отличаются только тем, куда смотрит FK и куда уходит
        рассылка; вся остальная механика (валидация ключа, лимит разных
        эмодзи, идемпотентность) у них общая, поэтому ветвление точечное, а
        не двумя копиями метода.
        """
        message_id = data.get("message_id")
        emoji = emoji_keys.normalize(data.get("emoji"))
        if not message_id or not emoji:
            return
        result = await self._toggle_reaction(message_id, emoji, add, dm)
        if not result:
            return
        if dm:
            await self.channel_layer.group_send(
                f"conversation_{result['conversation_id']}",
                {"type": "broadcast", "payload": {
                    "op": "dm_message_reactions",
                    "message_id": message_id,
                    "conversation_id": result["conversation_id"],
                    "reactions": result["reactions"],
                }})
            return
        await self.channel_layer.group_send(
            f"server_{result['server_id']}",
            {"type": "broadcast", "payload": {
                "op": "message_reactions",
                "message_id": message_id,
                "channel_id": result["channel_id"],
                "reactions": result["reactions"],
            }})

    async def _kick_other_devices(self):
        """Один аккаунт — один голосовой звонок одновременно, будь то канал
        сервера или диалог/группа. presence.join_voice (см. presence.py) уже
        атомарно переносит единственный "где я в голосе" слот на новую
        комнату, но ОСТАЛЬНЫЕ подключения этого аккаунта (другой браузер,
        телефон — те же WS-соединения в personal_group) об этом не знают:
        их локальный WebRTC/SFU как ни в чём не бывало продолжал бы слать и
        принимать медиа. Рассылаем им команду разорвать голос локально;
        себя самого (инициатора) исключает connection_id — см. broadcast()."""
        await self.channel_layer.group_send(
            self.personal_group, {"type": "broadcast", "payload": {
                "op": "voice_kicked_other_device",
                "connection_id": self.connection_id,
            }})

    async def _handle_voice_join(self, data):
        channel_id = data.get("channel_id")
        if not channel_id:
            return
        server_id = await self._voice_channel_server(channel_id)
        if not server_id:
            return
        await self._kick_other_devices()
        peer_ids, emptied_room = await asyncio.to_thread(
            presence.join_voice, self.uid, channel_id, self.connection_id)
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
        await self._kick_other_devices()
        room = dm_room(conversation_id)
        peer_ids, emptied_room = await asyncio.to_thread(
            presence.join_voice, self.uid, room, self.connection_id)
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

    async def _handle_voice_wake_user(self, data):
        target_user_id = data.get("target_user_id")
        if not target_user_id or int(target_user_id) == self.user.id:
            return
        own_room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not own_room or is_dm_room(own_room):
            return
        target_room = await asyncio.to_thread(presence.voice_channel, str(target_user_id))
        if target_room != own_room:
            return
        # Будить можно только того, кто сам молчит (выключил микрофон или
        # звук) — проверяем на сервере, а не только на клиенте (та же
        # кнопка там задизейблена, но это легко обойти прямой отправкой op).
        flags = await asyncio.to_thread(presence.voice_flags, str(target_user_id))
        if not (flags["muted"] or flags["deafened"]):
            return
        await self.channel_layer.group_send(
            f"user_{target_user_id}", {"type": "broadcast", "payload": {
                "op": "voice_wake_requested",
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
        if not roles.has_permission(self.user, server, "manage_members"):
            return False
        # Иерархия ролей действует и здесь: отключить от голоса можно только
        # того, кто строго ниже — иначе модератор глушил бы администратора.
        return roles.can_act_on_member(self.user, server, target_user_id)

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
            "display_name": self.user.display_name,
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

    async def _leave_voice_of_server(self, server_id):
        """Выкинуть из голосового канала сервера, из которого только что
        исключили. Сама presence-запись при удалении Membership не исчезает,
        так что без этого исключённый оставался бы в ростере канала."""
        room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not room or is_dm_room(room):
            return
        if await self._channel_server(room) != server_id:
            return
        await self._handle_voice_leave()
        await self._send({"op": "voice_kicked", "channel_id": int(room)})

    async def broadcast(self, event):
        """Обработчик group_send(type="broadcast")."""
        payload = event["payload"]
        op = payload.get("op")
        if op == "voice_kicked_other_device" and payload.get("connection_id") == self.connection_id:
            # Разослали САМИ (см. _kick_other_devices) — это соединение и
            # есть то самое "новое устройство", отключать нечего.
            return
        if op == "server_membership_granted":
            # Вступили в сервер (или одобрили заявку) с уже открытым сокетом.
            # Список server_-групп собирается один раз в connect(), поэтому
            # доподписываемся здесь — иначе realtime по этому серверу молчит
            # до перезагрузки страницы.
            group = f"server_{payload['server_id']}"
            if group not in self.server_groups:
                self.server_groups.append(group)
                await self.channel_layer.group_add(group, self.channel_name)
        elif op == "server_membership_revoked":
            # Выгнали/забанили — отписываемся немедленно, а не ждём, пока
            # пользователь сам закроет вкладку (до этого он продолжал читать
            # весь чат и presence сервера).
            group = f"server_{payload['server_id']}"
            if group in self.server_groups:
                self.server_groups.remove(group)
                await self.channel_layer.group_discard(group, self.channel_name)
            await self._leave_voice_of_server(payload["server_id"])
        elif op == "conversation_left":
            # Сами вышли из беседы (см. chat.views.ConversationDetail.delete) —
            # отписываемся, иначе продолжали бы получать её сообщения.
            group = f"conversation_{payload['conversation_id']}"
            if group in self.conversation_groups:
                self.conversation_groups.remove(group)
                await self.channel_layer.group_discard(group, self.channel_name)
        if op == "conversation_create":
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

    def _bind_attachments(self, attachment_ids, **owner):
        """Привязать ранее загруженные файлы к только что созданному сообщению.

        Забрать можно только СВОЮ загрузку, ещё не привязанную ни к какому
        сообщению: без первого условия чужой файл прикреплялся бы к своему
        сообщению по одному лишь известному id, без второго — один и тот же
        файл переезжал бы из старого сообщения в новое (и исчезал из старого).

        select_for_update держит строки до конца транзакции: две параллельные
        отправки с одним id иначе обе прошли бы фильтр и вторая перетёрла бы
        привязку первой. Вызывается только внутри transaction.atomic().
        """
        if not attachment_ids:
            return
        owned = list(
            Attachment.objects.select_for_update().filter(
                id__in=attachment_ids,
                uploaded_by=self.user,
                message__isnull=True,
                conversation_message__isnull=True,
            )
        )
        if not owned:
            return
        for attachment in owned:
            for field, value in owner.items():
                setattr(attachment, field, value)
        Attachment.objects.bulk_update(owned, list(owner))

    @database_sync_to_async
    def _create_message(self, channel_id, content, reply_to_id=None,
                        attachment_ids=None):
        try:
            channel = Channel.objects.select_related("server").get(id=channel_id)
        except Channel.DoesNotExist:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        perms = roles.permissions_for(self.user, channel.server)
        if not perms.get("view_channels") or not perms.get("send_messages"):
            return None
        reply_to = None
        if reply_to_id:
            # Разрешаем отвечать только на сообщение из ЭТОГО ЖЕ канала —
            # иначе можно было бы подсунуть id из чужого канала.
            reply_to = Message.objects.filter(
                id=reply_to_id, channel_id=channel_id).first()
        # Транзакция: сообщение и его вложения должны появиться вместе. Иначе
        # при сбое между ними в канал уезжало бы пустое сообщение без файлов,
        # ради которых его и отправляли.
        with transaction.atomic():
            msg = Message.objects.create(
                channel=channel, author=self.user, content=content,
                reply_to=reply_to)
            self._bind_attachments(attachment_ids, message=msg)
        # Сериализация уже ПОСЛЕ коммита: msg.attachments — обратная связь без
        # prefetch, то есть отдельный запрос в момент обращения, и внутри
        # транзакции он бы отработал так же. Но так payload гарантированно
        # описывает то, что реально лежит в БД к моменту рассылки.
        return {"server_id": channel.server_id, "data": MessageSerializer(msg).data}

    @database_sync_to_async
    def _delete_message(self, message_id):
        # Логи ниже — единственный след неудачного удаления: клиенту в ответ
        # на delete_message никогда не шлётся ни ошибка, ни подтверждение
        # (см. _handle_delete_message), так что без них "тихий" отказ
        # (сообщение не найдено / не участник / нет прав) не отличить от
        # обычной сетевой задержки на стороне поддержки.
        try:
            msg = Message.objects.select_related("channel__server").get(id=message_id)
        except Message.DoesNotExist:
            logger.warning(
                "delete_message: message %s not found (requested by user %s)",
                message_id, self.user.id,
            )
            return None
        server = msg.channel.server
        if not Membership.objects.filter(user=self.user, server=server).exists():
            logger.warning(
                "delete_message: user %s is not a member of server %s (message %s)",
                self.user.id, server.id, message_id,
            )
            return None
        # Удалить может автор ИЛИ тот, кому роль даёт «Удаление сообщений»
        # (владельцу сервера chat.roles выдаёт все права безусловно).
        if msg.author_id != self.user.id and not roles.has_permission(
            self.user, server, "delete_messages"
        ):
            logger.warning(
                "delete_message: user %s lacks permission to delete message %s "
                "(author %s) on server %s",
                self.user.id, message_id, msg.author_id, server.id,
            )
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
        """server_id, если это голосовой канал, юзер — участник сервера и у
        него есть права видеть канал и говорить в нём, иначе None.

        view_channels/speak проверяются и здесь, и в VoiceCredentials: там —
        чтобы не выдать медиа-токен, тут — чтобы не пустить в presence-ростер
        канала (иначе участник без права «Говорить» всё равно висел бы в
        списке подключённых, просто молча).
        """
        try:
            channel = Channel.objects.select_related("server").get(id=channel_id)
        except (Channel.DoesNotExist, ValueError, TypeError):
            return None
        if channel.kind != Channel.VOICE:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        perms = roles.permissions_for(self.user, channel.server)
        if not perms.get("view_channels") or not perms.get("speak"):
            return None
        return channel.server_id

    @database_sync_to_async
    def _channel_server(self, channel_id):
        # ValueError/TypeError — на случай, если сюда всё-таки долетит
        # синтетическая комната dm_<id> (см. models.is_dm_room): id канала
        # целочисленный, и Django бросит именно их, а не DoesNotExist.
        try:
            return Channel.objects.get(id=channel_id).server_id
        except (Channel.DoesNotExist, ValueError, TypeError):
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
    def _create_dm_message(self, conversation_id, content, reply_to_id=None,
                           attachment_ids=None):
        if not ConversationParticipant.objects.filter(
            user=self.user, conversation_id=conversation_id
        ).exists():
            return None
        reply_to = None
        if reply_to_id:
            # Только сообщение из ЭТОГО ЖЕ диалога — как и в _create_message.
            reply_to = ConversationMessage.objects.filter(
                id=reply_to_id, conversation_id=conversation_id).first()
        with transaction.atomic():
            msg = ConversationMessage.objects.create(
                conversation_id=conversation_id, author=self.user,
                content=content, reply_to=reply_to)
            self._bind_attachments(attachment_ids, conversation_message=msg)
        return ConversationMessageSerializer(msg).data

    @database_sync_to_async
    def _toggle_reaction(self, message_id, emoji, add: bool, dm: bool):
        """Поставить/снять реакцию. None — операция не состоялась (нет
        сообщения, нет доступа, упёрлись в лимит) и рассылать нечего.

        Идемпотентна: повторное «поставить» уже стоящую реакцию (двойной клик,
        две вкладки) не ошибка — get_or_create просто ничего не меняет, и
        актуальный набор всё равно уезжает всем, приводя клиентов к общему
        состоянию.
        """
        if dm:
            msg = ConversationMessage.objects.filter(id=message_id).first()
            if msg is None:
                return None
            # Реакцию может ставить любой участник беседы — как и читать её.
            if not ConversationParticipant.objects.filter(
                user=self.user, conversation_id=msg.conversation_id
            ).exists():
                return None
            owner = {"conversation_message": msg}
        else:
            msg = Message.objects.select_related("channel__server").filter(
                id=message_id).first()
            if msg is None:
                return None
            server = msg.channel.server
            if not Membership.objects.filter(
                user=self.user, server=server
            ).exists():
                return None
            # Право ровно то же, что нужно, чтобы сообщение вообще видеть.
            # Отдельного «можно ставить реакции» нет: реакция — это чтение с
            # обратной связью, а не сообщение (send_messages не требуется).
            if not roles.permissions_for(self.user, server).get("view_channels"):
                return None
            owner = {"message": msg}

        if add:
            # Лимит считаем по РАЗНЫМ эмодзи и только когда добавляется новый:
            # 21-й человек, ставящий уже существующую реакцию, ни во что не
            # упирается — ограничение на ширину ленты, а не на число людей.
            existing = set(
                Reaction.objects.filter(**owner).values_list("emoji", flat=True))
            if emoji not in existing and len(existing) >= MAX_REACTIONS_PER_MESSAGE:
                return None
            Reaction.objects.get_or_create(user=self.user, emoji=emoji, **owner)
        else:
            Reaction.objects.filter(user=self.user, emoji=emoji, **owner).delete()

        payload = {"reactions": reactions_payload(
            Reaction.objects.filter(**owner).order_by("created_at", "id"))}
        if dm:
            payload["conversation_id"] = msg.conversation_id
        else:
            payload["channel_id"] = msg.channel_id
            payload["server_id"] = msg.channel.server_id
        return payload

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
