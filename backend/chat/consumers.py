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
    {"op": "pin_message", "message_id": <id>, "pinned": bool} — закрепить/
     открепить сообщение в текстовом канале (нужно право "pin_messages";
     открепить может ещё и "delete_messages" — «Управление сообщениями»).
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
    {"op": "voice_move_user", "user_id": <id>, "channel_id": <id>} —
     переместить участника ИЗ его текущего голосового канала В указанный
     (перетаскивание строки участника на другой канал в сайдбаре; нужно
     право "manage_members" и оба канала на одном сервере, владельца сервера
     переместить нельзя). Себя самого этим оп'ом не двигают — перетаскивание
     своей строки клиент обрабатывает как обычный voice_join, без похода
     сюда вовсе.
    {"op": "voice_mute_vote_start", "target_user_id": <id>} — начать
     голосование за мут участника, который сейчас в ТОМ ЖЕ голосовом канале,
     что и отправитель (нужно право "start_mute_vote").
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
    {"op": "soundboard_play", "sound_id": <id>} — проиграть звук соундборда
     всем, кто сейчас в ТОМ ЖЕ голосовом канале, что и отправитель. Канал
     сервер берёт из presence сам — прислать чужой нельзя.
    {"op": "poll_vote", "poll_id": <id>, "option_ids": [<id>, ...]} —
     отдать/переставить свой голос. Пустой список снимает голос вовсе.
     В обычном (не multiple) опросе учитывается только первый вариант из
     списка: «проголосовать за два» там не ошибка клиента, а бессмыслица,
     и отказывать с текстом не за что.
    {"op": "poll_close", "poll_id": <id>} — закрыть опрос досрочно. Может
     автор сообщения либо распоряжающийся сообщениями (delete_messages).
     Обратной операции нет намеренно: «переоткрыть» опрос — это способ
     дособрать голоса после того, как результат уже увидели.
    {"op": "typing_start", "channel_id": <id>}
    {"op": "typing_start", "conversation_id": <id>} — «я печатаю здесь».
     Клиент шлёт его не на каждую букву, а раз в TYPING_THROTTLE_SEC, пока
     человек продолжает набирать (см. web/src/typing.ts). Событие
     эфемерное: ни в БД, ни в Redis ничего не пишется, срок жизни держит
     сам получатель.
    {"op": "set_status", "status": "online" | "dnd" | "invisible"}
    {"op": "ping"}  — хартбит, см. presence.heartbeat/chat.heartbeat_sweep;
     сервер обязан ответить {"op": "pong"} (см. ниже — на нём держится
     распознавание «мёртвого» сокета на клиенте).

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
    {"op": "pong"} — ответ на ping. Нужен НЕ для presence (его продлевает сам
     ping), а для того, чтобы клиент вообще мог узнать, что соединение умерло:
     при смене сети, NAT-таймауте роутера или выходе ноутбука из сна TCP
     остаётся «полуоткрытым» — close-фрейм не приходит никогда, readyState у
     браузера так и висит OPEN, и без ответа сервера вкладка молча живёт с
     мёртвым сокетом (см. web/src/gateway.tsx, watchdog).
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
    {"op": "voice_moved", "channel_id": <id>} — персонально тому, кого только
     что переместили в другой голосовой канал (voice_move_user). В отличие
     от voice_kicked сервер НИЧЕГО не делает с presence сам — клиент обязан
     сам вызвать обычный voice_join по этому channel_id: реальный WebRTC-
     транспорт живёт на клиенте и требует настоящего join'а к SFU нового
     канала, переставить его чужим соединением нельзя физически.
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
    {"op": "soundboard_play", "sound_id": <id>, "url": "/media/...",
     "user_id": <id>, "channel_id": "<room>"} — проиграть звук. Летит ВСЕМ на
     сервере (как и остальная голосовая мета), а решение «я сейчас в этом
     канале, значит играю» принимает клиент — ровно так же, как он делает это
     для звуков входа/выхода.
    {"op": "server_sounds", "server_id": <id>, "sounds": [...]} — набор
     звуков сервера изменился (залили/удалили/переименовали). Целиком, а не
     дельтой — набор маленький (см. _broadcast_sounds_update).
    {"op": "poll_update", "poll": {...}, "channel_id": <id>|null,
     "conversation_id": <id>|null} — актуальное состояние опроса после
     чьего-то голоса или закрытия. Целиком, а не дельтой: набор маленький, а
     дельты пришлось бы применять по порядку, который в распределённой
     рассылке не гарантирован (та же логика, что у message_reactions).
     Свой ли голос — клиент выводит сам из voter_ids: payload одинаков для
     всех получателей, иначе его пришлось бы собирать на каждого отдельно.
    {"op": "typing", "user_id": <id>, "channel_id": <id>} и
    {"op": "typing", "user_id": <id>, "conversation_id": <id>} — кто-то
     печатает. Уходит и самому печатающему тоже (рассылка на всю группу
     канала/диалога) — клиент отфильтровывает себя сам, отдельная личная
     рассылка «всем кроме одного» тут не окупается.
     Событие БЕЗ парного "перестал печатать": надёжной пары не выходит —
     вкладку закрывают, сеть отваливается, и «печатает…» висело бы вечно.
     Вместо этого у события есть срок годности на стороне получателя
     (TYPING_TTL_MS в web/src/typing.ts), а отправитель, пока печатает,
     присылает его заново.

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
pin_message — закрепление это модерация канала, а не право на своё
сообщение: закреплять и откреплять может тот, у кого есть "delete_messages"
(автору своего сообщения этого мало — иначе каждый вешал бы себя в шапку).

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
import math
import time
import uuid
from datetime import timedelta
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from django.db import transaction
from django.db.models import Q

from accounts.models import Friendship

from . import emoji as emoji_keys, mute_vote, presence, roles
from .permissions import can_see_channel

logger = logging.getLogger(__name__)
from .models import (
    Attachment, Channel, ConversationMessage, ConversationParticipant,
    MAX_ATTACHMENTS_PER_MESSAGE, MAX_POLL_OPTION_LEN, MAX_POLL_OPTIONS,
    MAX_POLL_QUESTION_LEN, MAX_REACTIONS_PER_MESSAGE, MIN_POLL_OPTIONS,
    Membership, Message, Poll, PollOption, PollVote, Reaction, SoundboardSound,
    ThreadMember, dm_conversation_id, dm_room, is_dm_room,
)
from .serializers import (
    ChannelSerializer, ConversationMessageSerializer, MessageSerializer,
    poll_payload, reactions_payload,
)

# Сколько недавних nonce'ов помнит соединение, чтобы узнать повторную попытку
# отправки (см. докстринг модуля). Ретрай приходит секунды спустя и почти
# всегда следующим же сообщением, так что глубина нужна символическая — но не
# единица: между исходной попыткой и её ретраем клиент мог успеть отправить
# что-то ещё.
NONCE_MEMORY = 50

# Нижняя граница между двумя typing_start от ОДНОГО соединения в одном и том
# же месте. Клиент и так шлёт их редко (см. web/src/typing.ts), но верить в
# это нельзя: op дешёвый на вид, а каждый вызов — проверка прав в БД и
# рассылка на всю группу сервера. Порог заметно меньше клиентского интервала,
# чтобы честный клиент в него никогда не упирался.
TYPING_THROTTLE_SEC = 2.0

# Сколько мест (каналов/диалогов) помнит троттл выше. Ограничение нужно
# только чтобы словарь не рос бесконечно у соединения, которое ходит по
# сотням каналов за сессию; сам порядок вытеснения роли не играет.
TYPING_THROTTLE_MEMORY = 50


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

        # "channel:12"/"conversation:3" -> monotonic-время последнего typing_start
        # отсюда. Живёт в памяти соединения, как и _recent_nonces: троттлить
        # нужно конкретный сокет, а не аккаунт целиком — две вкладки в разных
        # каналах друг другу не мешают.
        self._last_typing: dict[str, float] = {}

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
            elif op == "pin_message":
                await self._handle_pin_message(data)
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
            elif op == "voice_move_user":
                await self._handle_voice_move_user(data)
            elif op == "voice_mute_vote_start":
                await self._handle_voice_mute_vote_start(data)
            elif op == "voice_mute_vote_cast":
                await self._handle_voice_mute_vote_cast(data)
            elif op == "voice_request_screen_share":
                await self._handle_voice_request_screen_share(data)
            elif op == "voice_wake_user":
                await self._handle_voice_wake_user(data)
            elif op == "soundboard_play":
                await self._handle_soundboard_play(data)
            elif op == "poll_vote":
                await self._handle_poll_vote(data)
            elif op == "poll_close":
                await self._handle_poll_close(data)
            elif op == "typing_start":
                await self._handle_typing_start(data)
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
                # Ответ — ПЕРВЫМ делом и всегда, ещё до похода в Redis за
                # presence: для клиента это единственный признак живого
                # соединения, и задерживать его (а тем более потерять из-за
                # исключения ниже) значит заставить исправный сокет считаться
                # мёртвым и переподключиться на ровном месте.
                await self._send({"op": "pong"})
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
    @staticmethod
    def _read_poll(data):
        """Опрос из payload'а отправки — или None, если его там нет.

        Возвращает уже причёсанное: вопрос и варианты обрезаны по длине,
        пустые варианты выброшены, дубликаты схлопнуты (два одинаковых
        варианта — это не выбор, а способ размазать голоса). Если после
        чистки вариантов меньше двух, опроса нет: молча отправится обычное
        сообщение, потому что отказывать тут не за что — форму на клиенте
        всё равно не отправить незаполненной.
        """
        raw = data.get("poll")
        if not isinstance(raw, dict):
            return None
        question = (raw.get("question") or "").strip()[:MAX_POLL_QUESTION_LEN]
        if not question:
            return None
        options, seen = [], set()
        for item in (raw.get("options") or [])[:MAX_POLL_OPTIONS]:
            if not isinstance(item, str):
                continue
            text = item.strip()[:MAX_POLL_OPTION_LEN]
            key = text.casefold()
            if not text or key in seen:
                continue
            seen.add(key)
            options.append(text)
        if len(options) < MIN_POLL_OPTIONS:
            return None
        hours = raw.get("duration_hours")
        closes_at = None
        if isinstance(hours, (int, float)) and 0 < hours <= 24 * 14:
            closes_at = timezone.now() + timedelta(hours=float(hours))
        return {
            "question": question,
            "options": options,
            "multiple": bool(raw.get("multiple")),
            "closes_at": closes_at,
        }

    @staticmethod
    def _attach_poll(spec, *, message=None, conversation_message=None):
        """Создать опрос у только что созданного сообщения.

        Зовётся ВНУТРИ той же транзакции, что и само сообщение: сообщение
        «Кто идёт?» без вариантов ответа — не то, что человек отправлял.
        """
        if not spec:
            return
        poll = Poll.objects.create(
            message=message,
            conversation_message=conversation_message,
            question=spec["question"],
            multiple=spec["multiple"],
            closes_at=spec["closes_at"],
        )
        PollOption.objects.bulk_create([
            PollOption(poll=poll, text=text, position=i)
            for i, text in enumerate(spec["options"])
        ])

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
        poll_spec = self._read_poll(data)
        nonce = self._read_nonce(data)
        if not channel_id:
            await self._nack(nonce, "Канал не указан.")
            return
        # Пустое сообщение без вложений отправлять нечего, но сообщение из
        # одних вложений — нормально (см. Message.content). Опрос здесь в том
        # же ряду: у него свой текст (вопрос), и подписывать его сверху ещё и
        # сообщением человек не обязан.
        if not content and not attachment_ids and not poll_spec:
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
            channel_id, content[:4000], data.get("reply_to"), attachment_ids,
            poll_spec)
        if not result or result.get("error"):
            await self._nack(
                nonce, (result or {}).get("error") or "Нет доступа к каналу.")
            return
        self._remember_nonce(nonce, result["data"]["id"])
        # Ветка вернулась из архива этой самой отправкой — сначала событие про
        # неё, потом само сообщение: иначе клиент на миг получил бы сообщение в
        # канал, которого у него в сайдбаре ещё нет.
        if result.get("unarchived"):
            await self._broadcast_channel_update(result["unarchived"])
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

    async def _broadcast_channel_update(self, event):
        """channel_update по каналу из _channel_event_payload — всем участникам
        сервера, а для приватного (и веток в нём) поимённо тем, кому он виден.
        Ровно то же правило, что и у REST-ручек, см.
        chat.views._broadcast_channel_event."""
        channel = event["channel"]
        payload = {
            "op": "channel_update",
            "server_id": channel["server"],
            "channel": channel,
        }
        if event["user_ids"] is None:
            await self.channel_layer.group_send(
                f"server_{channel['server']}",
                {"type": "broadcast", "payload": payload})
            return
        for user_id in event["user_ids"]:
            await self.channel_layer.group_send(
                f"user_{user_id}", {"type": "broadcast", "payload": payload})

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

    async def _handle_pin_message(self, data):
        message_id = data.get("message_id")
        if not message_id:
            return
        result = await self._pin_message(message_id, bool(data.get("pinned")))
        if not result:
            return
        # Отдельного op'а нет: закрепление — это изменение самого сообщения
        # (поле pinned в MessageSerializer), и лента обновляет его тем же
        # обработчиком, что и правку текста.
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
        poll_spec = self._read_poll(data)
        nonce = self._read_nonce(data)
        if not conversation_id:
            await self._nack(nonce, "Диалог не указан.")
            return
        if not content and not attachment_ids and not poll_spec:
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
            conversation_id, content[:4000], data.get("reply_to"), attachment_ids,
            poll_spec)
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

    async def _handle_soundboard_play(self, data):
        """Проиграть звук соундборда всем в моём голосовом канале.

        Канал берётся из presence отправителя, а не из запроса: иначе любой
        мог бы устроить звук в чужом канале, где его самого нет.
        """
        sound_id = data.get("sound_id")
        if not sound_id:
            return
        room = await asyncio.to_thread(presence.voice_channel, self.uid)
        if not room:
            # Не в голосе — играть некому и негде.
            return

        sound = await self._readable_sound(sound_id, room)
        if not sound:
            return

        payload = {
            "op": "soundboard_play",
            "sound_id": sound["id"],
            "url": sound["url"],
            "user_id": self.user.id,
            "channel_id": room,
        }
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

    @database_sync_to_async
    def _readable_sound(self, sound_id, room):
        """{"id", "url"} звука, который мне можно здесь проиграть, иначе None.

        Звук принадлежит серверу, и играть его можно там же: в голосовом
        канале ТОГО ЖЕ сервера. В звонке лички/группы сервера нет вовсе —
        поэтому туда годится любой звук с любого МОЕГО сервера (ровно та же
        логика, что у кастомных эмодзи в личке, см. chat.emoji.usable_ids).
        """
        try:
            sound = SoundboardSound.objects.select_related("server").get(id=sound_id)
        except SoundboardSound.DoesNotExist:
            return None
        if not Membership.objects.filter(
            user=self.user, server=sound.server
        ).exists():
            return None
        if not is_dm_room(room):
            channel = Channel.objects.filter(id=room).first()
            if not channel or channel.server_id != sound.server_id:
                return None
        return {"id": sound.id, "url": sound.file.url if sound.file else ""}

    async def _handle_poll_vote(self, data):
        poll_id = data.get("poll_id")
        option_ids = data.get("option_ids")
        if not poll_id or not isinstance(option_ids, list):
            return
        # Ограничиваем длину до похода в БД: список приходит от клиента, и
        # тысяча id в нём — это тысяча проверок на ровном месте.
        option_ids = [
            o for o in option_ids[:MAX_POLL_OPTIONS] if isinstance(o, int)
        ]
        result = await self._cast_poll_vote(poll_id, option_ids)
        if result:
            await self._broadcast_poll(result)

    async def _handle_poll_close(self, data):
        poll_id = data.get("poll_id")
        if not poll_id:
            return
        result = await self._close_poll(poll_id)
        if result:
            await self._broadcast_poll(result)

    async def _broadcast_poll(self, result):
        """poll_update — туда же, куда ушло бы само сообщение с опросом."""
        payload = {
            "op": "poll_update",
            "poll": result["poll"],
            "channel_id": result.get("channel_id"),
            "conversation_id": result.get("conversation_id"),
        }
        if result.get("conversation_id"):
            await self.channel_layer.group_send(
                f"conversation_{result['conversation_id']}",
                {"type": "broadcast", "payload": payload})
        else:
            await self.channel_layer.group_send(
                f"server_{result['server_id']}",
                {"type": "broadcast", "payload": payload})

    async def _handle_typing_start(self, data):
        """«Я печатаю» — в канал/ветку или в личку/группу.

        Молча ничего не делает при отказе: печатание — не действие
        пользователя, а побочный эффект набора текста, и сообщать в интерфейс
        «вам нельзя печатать» не о чем.
        """
        channel_id = data.get("channel_id")
        conversation_id = data.get("conversation_id")
        # Ровно одно из двух. Оба разом — испорченный клиент, и гадать, что он
        # имел в виду, не нужно.
        if bool(channel_id) == bool(conversation_id):
            return

        key = f"channel:{channel_id}" if channel_id else f"conversation:{conversation_id}"
        now = time.monotonic()
        last = self._last_typing.get(key)
        if last is not None and now - last < TYPING_THROTTLE_SEC:
            return
        if len(self._last_typing) >= TYPING_THROTTLE_MEMORY:
            self._last_typing.pop(next(iter(self._last_typing)), None)
        self._last_typing[key] = now

        if channel_id:
            server_id = await self._typing_allowed_in_channel(channel_id)
            if not server_id:
                return
            await self.channel_layer.group_send(
                f"server_{server_id}",
                {"type": "broadcast", "payload": {
                    "op": "typing",
                    "user_id": self.user.id,
                    "channel_id": channel_id,
                }},
            )
            return

        if not await self._is_conversation_participant(conversation_id):
            return
        await self.channel_layer.group_send(
            f"conversation_{conversation_id}",
            {"type": "broadcast", "payload": {
                "op": "typing",
                "user_id": self.user.id,
                "conversation_id": conversation_id,
            }},
        )

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

    async def _handle_voice_move_user(self, data):
        """Переместить участника ИЗ его текущего голосового канала В другой —
        аналог перетаскивания строки участника на другой канал в сайдбаре.

        В отличие от _handle_voice_disconnect_user, здесь НЕ трогаем presence
        вообще: голос на сервере — это тонкая мета (кто где), а настоящий
        WebRTC-транспорт живёт на клиенте цели и требует НАСТОЯЩЕГО join'а к
        SFU нового канала — переставить его отсюда, чужим соединением,
        нельзя физически. Поэтому обработчик — чистая проверка прав плюс
        персональный пинг: клиент цели сам вызовет обычный voice_join, когда
        получит voice_moved (см. web/src/hooks/useGatewayEvents.ts) — со
        стороны цели это неотличимо от того, как если бы она сама кликнула
        по новому каналу.

        Себя самого этим оп'ом не двигают: перетаскивание своей же строки
        клиент обрабатывает как обычный клик по каналу (voice_join), без
        похода на бэк вообще — правами это не режется, потому что права там
        и не нужны (см. web/src/hooks/useVoiceCall.ts handleMoveVoiceUser).
        """
        target_user_id = data.get("user_id")
        dest_channel_id = data.get("channel_id")
        if not target_user_id or not dest_channel_id or int(target_user_id) == self.user.id:
            return
        target_user_id = int(target_user_id)
        # _voice_channel_server проверяет, что self.user (тот, кто тащит)
        # сам вправе видеть канал назначения и подключаться к нему — то же
        # самое, что потребовалось бы, если бы он заходил туда сам.
        dest_server_id = await self._voice_channel_server(dest_channel_id)
        if not dest_server_id:
            return
        target_room = await asyncio.to_thread(presence.voice_channel, str(target_user_id))
        if not target_room or is_dm_room(target_room):
            return
        if int(target_room) == int(dest_channel_id):
            return  # уже там
        target_server_id = await self._channel_server(target_room)
        if target_server_id != dest_server_id:
            return  # только внутри одного сервера — иначе неоднозначно, куда «доставать» цель
        allowed = await self._can_manage_members(dest_server_id, target_user_id)
        if not allowed:
            return
        await self.channel_layer.group_send(
            f"user_{target_user_id}", {"type": "broadcast", "payload": {
                "op": "voice_moved",
                "channel_id": int(dest_channel_id),
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
        if not await self._has_server_permission(server_id, "start_mute_vote"):
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
        server_id = await self._channel_server(own_room)
        if not server_id or not await self._has_server_permission(
            server_id, "request_screen_share"
        ):
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
    def _has_server_permission(self, server_id, permission):
        from .models import Server
        server = Server.objects.filter(id=server_id).first()
        return bool(server) and roles.has_permission(self.user, server, permission)

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

        # Друзья и собеседники — вне серверов у них раньше не было НИКАКОГО
        # источника чужого статуса, поэтому точка на аватарке в списке друзей
        # и диалогов не могла ожить (см. chat.views.PresenceView — она отдаёт
        # ровно тот же круг людей снимком на старте, а это его живое
        # продолжение).
        #
        # Персонально каждому, а не в conversation_-группы, и с вычетом тех,
        # до кого presence уже дошёл серверной рассылкой выше (см.
        # _presence_extra_recipient_ids): иначе друг, с которым мы ещё и на
        # общем сервере, получал бы одно и то же событие дважды.
        #
        # Строго ПОСЛЕ рассылки по серверам: запрос к БД перед ней сдвинул бы
        # её по времени — ровно то, чего избегает комментарий в connect().
        for uid in await self._presence_extra_recipient_ids():
            await self.channel_layer.group_send(
                f"user_{uid}", {"type": "broadcast", "payload": payload})

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

    def _attachments_denied(self, attachment_ids, perms):
        """Текст отказа, если этих вложений здесь прикреплять нельзя, иначе None.

        Права два, и они разные: обычный файл закрыт attach_files, голосовое —
        своим send_voice_messages (см. chat.roles: «не засоряйте канал файлами»
        и «не наговаривайте вместо текста» — разные пожелания). Поэтому мало
        посмотреть на список id: нужно знать, что именно за ними лежит.

        Запрос идёт по СВОИМ непривязанным загрузкам — ровно по тем, которые
        потом заберёт _bind_attachments: чужой или уже отправленный id всё
        равно не прикрепится, и отказывать из-за него было бы неправдой.

        Синхронный метод — вызывается уже внутри database_sync_to_async.
        """
        if not attachment_ids:
            return None
        kinds = set(
            Attachment.objects.filter(
                id__in=attachment_ids,
                uploaded_by=self.user,
                message__isnull=True,
                conversation_message__isnull=True,
            ).values_list("voice", flat=True)
        )
        if True in kinds and not perms.get("send_voice_messages"):
            return "Голосовые сообщения в этом канале запрещены."
        if False in kinds and not perms.get("attach_files"):
            return "Нельзя прикреплять файлы в этом канале."
        return None

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
                        attachment_ids=None, poll_spec=None):
        """Создаёт сообщение или возвращает {"error": "текст"} — текст уезжает
        клиенту в nack (см. _handle_send). Отдельный текст нужен из-за
        медленного режима: «подождите 7 с» и «нет доступа к каналу» для
        отправителя — совершенно разные ситуации, а раньше любой отказ
        выглядел одинаково."""
        try:
            # parent — ради веток: и can_see_channel ниже, и разархивация в
            # конце спрашивают родителя, иначе на каждое сообщение в ветке
            # уходил бы лишний запрос за ним.
            channel = Channel.objects.select_related("server", "parent").get(
                id=channel_id)
        except Channel.DoesNotExist:
            return {"error": "Нет доступа к каналу."}
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return {"error": "Нет доступа к каналу."}
        perms = roles.permissions_for(self.user, channel.server)
        if not perms.get("view_channels") or not perms.get("send_messages"):
            return {"error": "Нет доступа к каналу."}
        if not can_see_channel(self.user, channel, perms):
            return {"error": "Нет доступа к каналу."}
        # Заблокированная ветка — читать можно, писать нельзя никому, кроме
        # распоряжающихся сообщениями. В отличие от архивной, сама собой она
        # не откроется: на то и блокировка, чтобы разговор не продолжили (см.
        # Channel.locked и разархивацию ниже).
        if channel.locked and not perms.get("delete_messages"):
            return {"error": "Ветка заблокирована."}
        denied = self._attachments_denied(attachment_ids, perms)
        if denied:
            return {"error": denied}
        wait = self._slowmode_wait(channel, perms)
        if wait:
            return {"error": f"Медленный режим: подождите {wait} с."}
        # Токены кастомных эмодзи, которых автору здесь нельзя, схлопываются в
        # ":имя:" — см. chat.emoji.sanitize_content, там же почему не отказом.
        content = emoji_keys.sanitize_content(content, self.user, channel.server)
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
            self._attach_poll(poll_spec, message=msg)
        result = {"server_id": channel.server_id, "data": MessageSerializer(msg).data}
        if channel.kind == Channel.THREAD:
            # Написал в ветку — значит участвуешь: ветка появляется в сайдбаре
            # и начинает приходить в уведомлениях, отдельно жать
            # «Присоединиться» не нужно (ровно как в Discord). get_or_create,
            # а не create: писать в свою же ветку можно сколько угодно раз.
            ThreadMember.objects.get_or_create(thread=channel, user=self.user)
        # Написали в закрытую ветку — она открывается обратно сама, как в
        # Discord: закрытие ветки говорит «разговор окончен», а новое сообщение
        # ровно это и опровергает. Заставлять человека сначала лезть в архив и
        # жать «Восстановить» значило бы требовать лишний шаг ради состояния,
        # которое он уже отменил самим фактом отправки.
        #
        # Заблокированную это не касается: туда пишет только модератор, и его
        # сообщение — не «разговор продолжился», а служебная реплика поверх
        # закрытой темы.
        if channel.kind == Channel.THREAD and channel.archived and not channel.locked:
            channel.archived = False
            channel.save(update_fields=["archived"])
            result["unarchived"] = self._channel_event_payload(channel)
        # Сериализация уже ПОСЛЕ коммита: msg.attachments — обратная связь без
        # prefetch, то есть отдельный запрос в момент обращения, и внутри
        # транзакции он бы отработал так же. Но так payload гарантированно
        # описывает то, что реально лежит в БД к моменту рассылки.
        return result

    def _channel_event_payload(self, channel):
        """Ветка для события channel_update: сам канал плюс поимённый список
        получателей, если он приватный (см. chat.views._broadcast_channel_event
        — здесь то же правило, но считать его надо синхронно, внутри уже
        открытого database_sync_to_async, а не в асинхронном обработчике).

        my_settings уходит нейтральным (сериализуем без request) — это общая
        для всех копия, чужие уведомления/заглушение в ней светиться не должны,
        см. chat.views._channel_broadcast_payload.
        """
        from .views import _channel_visible_user_ids

        return {
            "channel": ChannelSerializer(channel).data,
            "user_ids": (
                _channel_visible_user_ids(channel) if channel.is_private else None),
        }

    def _slowmode_wait(self, channel, perms) -> int:
        """Сколько ещё секунд автору ждать в этом канале (0 — можно писать).

        Отсчёт ведётся от ЕГО ЖЕ последнего сообщения в канале, а не от
        общего счётчика: медленный режим ограничивает частоту каждого
        участника по отдельности, а не темп канала целиком. Синхронный метод
        — вызывается уже внутри database_sync_to_async (_create_message)."""
        if not channel.slowmode_seconds or perms.get("bypass_slowmode"):
            return 0
        last = channel.messages.filter(author=self.user).order_by("-created_at").first()
        if last is None:
            return 0
        elapsed = (timezone.now() - last.created_at).total_seconds()
        remaining = channel.slowmode_seconds - elapsed
        # ceil: 0.2 секунды остатка — это всё ещё «подождите 1 с», а не 0,
        # иначе подсказка звала бы отправлять повторно раньше времени.
        return max(0, math.ceil(remaining))

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
        msg.content = emoji_keys.sanitize_content(
            content, self.user, msg.channel.server)
        msg.edited_at = timezone.now()
        msg.save(update_fields=["content", "edited_at"])
        return {
            "server_id": msg.channel.server_id,
            "data": MessageSerializer(msg).data,
        }

    @database_sync_to_async
    def _pin_message(self, message_id, pinned):
        try:
            msg = Message.objects.select_related(
                "channel__server", "author", "reply_to__author").get(id=message_id)
        except Message.DoesNotExist:
            return None
        server = msg.channel.server
        if not Membership.objects.filter(user=self.user, server=server).exists():
            return None
        perms = roles.permissions_for(self.user, server)
        # Закрепить — pin_messages; открепить может ещё и «Управление
        # сообщениями» (delete_messages): оно про наведение порядка в чужих
        # сообщениях, куда снятие чужого закрепления и относится.
        allowed = perms.get("pin_messages") or (
            not pinned and perms.get("delete_messages"))
        if not allowed:
            logger.info(
                "pin_message: user %s lacks permission to pin message %s on server %s",
                self.user.id, message_id, server.id,
            )
            return None
        was_pinned = msg.pinned
        if was_pinned == pinned:
            # Двойной клик/гонка двух модераторов — состояние уже нужное,
            # но время закрепления перебивать не за чем.
            return None
        msg.pinned_at = timezone.now() if pinned else None
        msg.save(update_fields=["pinned_at"])
        return {
            "server_id": server.id,
            "data": MessageSerializer(msg).data,
        }

    @database_sync_to_async
    def _voice_channel_server(self, channel_id):
        """server_id, если это голосовой канал, юзер — участник сервера и у
        него есть право видеть канал и подключаться к нему, иначе None.

        view_channels/connect проверяются и здесь, и в VoiceCredentials: там —
        чтобы не выдать медиа-токен, тут — чтобы не пустить в presence-ростер
        канала.

        Право «Говорить» (speak) здесь НЕ требуется: connect без speak — это
        слушатель, он законно сидит в канале и слышит остальных, просто его
        микрофон не публикуется (см. sfu.access_token, где speak уезжает
        отдельным claim'ом). Раньше на этом месте стоял speak, и роль
        «только слушать» была неотличима от полного запрета зайти.
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
        if not perms.get("view_channels") or not perms.get("connect"):
            return None
        if not can_see_channel(self.user, channel, perms):
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
    def _presence_extra_recipient_ids(self):
        """Кому мой presence нужно доставить ПЕРСОНАЛЬНО — друзьям и
        собеседникам, до которых не дотянулась рассылка по серверным группам
        (см. _broadcast_presence).

        Сокомандников по серверу вычитаем: они уже получили это событие через
        server_-группу, и второй экземпляр был бы чистым дублем — клиент
        обработал бы его повторно, а тесты вида «проверить, что сокет больше
        ничего не получил» ловили бы лишнее сообщение."""
        my_server_ids = Membership.objects.filter(user=self.user).values_list(
            "server_id", flat=True)
        already_reached = set(
            Membership.objects.filter(server_id__in=my_server_ids).values_list(
                "user_id", flat=True)
        )

        pairs = Friendship.objects.filter(status=Friendship.ACCEPTED).filter(
            Q(from_user=self.user) | Q(to_user=self.user)
        ).values_list("from_user_id", "to_user_id")
        recipients = {
            to_id if from_id == self.user.id else from_id
            for from_id, to_id in pairs
        }

        my_conversation_ids = ConversationParticipant.objects.filter(
            user=self.user).values_list("conversation_id", flat=True)
        recipients.update(
            ConversationParticipant.objects.filter(
                conversation_id__in=my_conversation_ids
            ).exclude(user=self.user).values_list("user_id", flat=True)
        )

        return list(recipients - already_reached - {self.user.id})

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

    def _poll_location(self, poll):
        """Где живёт опрос: (server_id, channel_id, conversation_id).

        Одно из двух последних всегда None — опрос висит либо на сообщении
        канала, либо на сообщении лички (см. models.Poll, constraint).
        """
        if poll.conversation_message_id:
            return None, None, poll.conversation_message.conversation_id
        message = poll.message
        return message.channel.server_id, message.channel_id, None

    def _can_touch_poll(self, poll):
        """Виден ли мне этот опрос настолько, чтобы в нём голосовать.

        Те же проверки, что у чтения ленты, где он висит: голосовать в
        канале, которого не видно, нельзя — иначе через подбор poll_id можно
        было бы и подсмотреть результаты, и накрутить их.
        """
        if poll.conversation_message_id:
            return ConversationParticipant.objects.filter(
                user=self.user,
                conversation_id=poll.conversation_message.conversation_id,
            ).exists()
        channel = poll.message.channel
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return False
        perms = roles.permissions_for(self.user, channel.server)
        if not perms.get("view_channels"):
            return False
        return can_see_channel(self.user, channel, perms)

    @database_sync_to_async
    def _cast_poll_vote(self, poll_id, option_ids):
        """Переставить свой голос. None — голосовать нельзя или нечего.

        Голос именно ПЕРЕставляется, а не добавляется: прежние голоса этого
        человека в этом опросе снимаются целиком, затем ставятся новые. Так
        обычный опрос («один вариант») получается без отдельной ветки кода, а
        повторный клик по тому же варианту — это просто снятие голоса.
        """
        try:
            poll = Poll.objects.select_related(
                "message__channel__server", "conversation_message",
            ).get(id=poll_id)
        except Poll.DoesNotExist:
            return None
        if not poll.is_open() or not self._can_touch_poll(poll):
            return None

        valid_ids = set(
            poll.options.filter(id__in=option_ids).values_list("id", flat=True))
        if not poll.multiple:
            # Не отказ: «выбрал два в опросе на один» — бессмыслица, а не
            # ошибка, о которой есть что сообщить. Берём первый по порядку,
            # заданному самим опросом, а не по порядку в запросе.
            ordered = [o for o in option_ids if o in valid_ids]
            valid_ids = set(ordered[:1])

        with transaction.atomic():
            PollVote.objects.filter(
                option__poll=poll, user=self.user).delete()
            PollVote.objects.bulk_create(
                [PollVote(option_id=oid, user=self.user) for oid in valid_ids])

        server_id, channel_id, conversation_id = self._poll_location(poll)
        return {
            "poll": poll_payload(self._reloaded_poll(poll.id)),
            "server_id": server_id,
            "channel_id": channel_id,
            "conversation_id": conversation_id,
        }

    @database_sync_to_async
    def _close_poll(self, poll_id):
        """Закрыть опрос досрочно — автор сообщения или delete_messages."""
        try:
            poll = Poll.objects.select_related(
                "message__author", "message__channel__server",
                "conversation_message__author",
            ).get(id=poll_id)
        except Poll.DoesNotExist:
            return None
        if poll.closed:
            return None

        owner_message = poll.message or poll.conversation_message
        allowed = owner_message.author_id == self.user.id
        if not allowed and poll.message_id:
            # В личке ролей нет — там закрыть может только автор.
            perms = roles.permissions_for(self.user, poll.message.channel.server)
            allowed = bool(perms.get("delete_messages"))
        if not allowed or not self._can_touch_poll(poll):
            return None

        poll.closed = True
        poll.save(update_fields=["closed"])
        server_id, channel_id, conversation_id = self._poll_location(poll)
        return {
            "poll": poll_payload(self._reloaded_poll(poll.id)),
            "server_id": server_id,
            "channel_id": channel_id,
            "conversation_id": conversation_id,
        }

    @staticmethod
    def _reloaded_poll(poll_id):
        """Опрос с подтянутыми вариантами и голосами — под poll_payload.

        Перечитываем, а не переиспользуем объект из вызывающего: там голоса
        только что менялись, и prefetch на нём отдал бы состояние ДО правки.
        """
        return Poll.objects.prefetch_related("options__votes").get(id=poll_id)

    @database_sync_to_async
    def _typing_allowed_in_channel(self, channel_id):
        """id сервера, если этому пользователю можно печатать в этом канале,
        иначе None.

        Проверки те же, что у отправки (см. _create_message), и это
        принципиально: «печатает…» — утечка присутствия. Без проверки видимости
        канала участник сервера, которому приватный канал не показан, всё
        равно светился бы в нём — а заодно и сам факт, что канал существует.

        Чего здесь нет по сравнению с отправкой — медленного режима и проверки
        вложений: они про конкретное сообщение, а не про право писать сюда
        вообще. Блокировка ветки, наоборот, есть: в заблокированной писать
        нельзя, значит и «печатает…» показывать не о чем.
        """
        try:
            channel = Channel.objects.select_related("server", "parent").get(
                id=channel_id)
        except Channel.DoesNotExist:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        perms = roles.permissions_for(self.user, channel.server)
        if not perms.get("view_channels") or not perms.get("send_messages"):
            return None
        if not can_see_channel(self.user, channel, perms):
            return None
        if channel.locked and not perms.get("delete_messages"):
            return None
        return channel.server_id

    @database_sync_to_async
    def _is_conversation_participant(self, conversation_id):
        return ConversationParticipant.objects.filter(
            user=self.user, conversation_id=conversation_id
        ).exists()

    @database_sync_to_async
    def _create_dm_message(self, conversation_id, content, reply_to_id=None,
                           attachment_ids=None, poll_spec=None):
        if not ConversationParticipant.objects.filter(
            user=self.user, conversation_id=conversation_id
        ).exists():
            return None
        # server=None: в личке ролей нет, ограничивать нечем — доступны эмодзи
        # всех моих серверов, но только их (см. chat.emoji.sanitize_content).
        content = emoji_keys.sanitize_content(content, self.user)
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
            self._attach_poll(poll_spec, conversation_message=msg)
        # Тот, кто «закрыл» эту переписку (см. ConversationParticipant.closed),
        # должен увидеть её снова — иначе сообщение пришло бы в диалог,
        # которого у него нет в списке, и он бы просто его не заметил.
        # Себя не трогаем: закрыл и сам же написал — список не дёргаем.
        ConversationParticipant.objects.filter(
            conversation_id=conversation_id, closed=True
        ).exclude(user=self.user).update(closed=False)
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
            perms = roles.permissions_for(self.user, server)
            if not perms.get("view_channels"):
                return None
            # add_reactions нужен только чтобы ПОСТАВИТЬ. Снять свою уже
            # стоящую реакцию можно всегда: иначе участник, у которого право
            # отобрали задним числом, остался бы навечно приклеен к реакциям,
            # которые успел наставить.
            if add and not perms.get("add_reactions"):
                return None
            owner = {"message": msg}

        if add:
            # Кастомный эмодзи — ещё и вопрос доступа: существует ли он и
            # можно ли ставить именно его именно здесь (см. chat.emoji.can_use;
            # server=None для лички — там ролей нет и ограничивать нечем).
            # Только на «поставить»: СНЯТЬ свою старую реакцию нужно уметь
            # всегда, даже если эмодзи с тех пор удалили с сервера или роль
            # потеряла право на внешние — иначе она осталась бы навечно.
            if not emoji_keys.can_use(emoji, self.user,
                                      None if dm else msg.channel.server):
                return None
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
        msg.content = emoji_keys.sanitize_content(content, self.user)
        msg.edited_at = timezone.now()
        msg.save(update_fields=["content", "edited_at"])
        return {
            "conversation_id": msg.conversation_id,
            "data": ConversationMessageSerializer(msg).data,
        }
