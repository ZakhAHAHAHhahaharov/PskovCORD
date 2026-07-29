"""
Presence через Redis.

- online: пользователь считается онлайн, пока у него есть хотя бы одно
  активное WebSocket-подключение (счётчик коннектов на юзера).
- voice: в каком голосовом канале сейчас находится пользователь.
- call state (call_started_at/topic): живёт только пока в голосовом канале
  кто-то есть — появляется при первом входе, стирается когда канал пустеет.
"""
import time

import redis
from django.conf import settings

_r = redis.from_url(settings.REDIS_URL, decode_responses=True)

ONLINE_SET = "presence:online"

# Сколько живёт heartbeat-запись без обновления, прежде чем uid считается
# «призраком» (WS оборвался без close-фрейма — сон/краш/вырубленный вайфай —
# и обычный disconnect() у GatewayConsumer так и не пришёл) и принудительно
# выкидывается из presence (см. heartbeat_sweep).
HEARTBEAT_TTL = 5 * 60

# Атомарно: переносит uid в новый voice-канал и возвращает участников,
# которые были там ДО него. Без этого два одновременных join гонятся за
# отдельными SMEMBERS/SADD и оба видят пустой список пиров.
_JOIN_VOICE_SCRIPT = """
local prev = redis.call('GET', KEYS[1])
if prev and prev ~= ARGV[2] then
    redis.call('SREM', 'voice:' .. prev, ARGV[1])
end
redis.call('SET', KEYS[1], ARGV[2])
local peers = redis.call('SMEMBERS', KEYS[2])
redis.call('SADD', KEYS[2], ARGV[1])
return peers
"""
_join_voice = _r.register_script(_JOIN_VOICE_SCRIPT)


def _conn_key(uid) -> str:
    return f"presence:conns:{uid}"


def _voice_key(uid) -> str:
    return f"presence:voice:{uid}"


def _voice_members_key(channel_id) -> str:
    return f"voice:{channel_id}"


def _voice_flags_key(uid) -> str:
    return f"presence:voice_flags:{uid}"


def _voice_owner_key(uid) -> str:
    return f"presence:voice_owner:{uid}"


def _call_started_key(channel_id) -> str:
    return f"presence:call_started:{channel_id}"


def _call_topic_key(channel_id) -> str:
    return f"presence:call_topic:{channel_id}"


def _heartbeat_key(uid) -> str:
    return f"presence:hb:{uid}"


# --- online -----------------------------------------------------------------
def user_connected(uid) -> int:
    uid = str(uid)
    n = _r.incr(_conn_key(uid))
    if n == 1:
        _r.sadd(ONLINE_SET, uid)
    return n


def user_disconnected(uid) -> int:
    uid = str(uid)
    n = _r.decr(_conn_key(uid))
    if n <= 0:
        _r.delete(_conn_key(uid))
        _r.srem(ONLINE_SET, uid)
        clear_voice(uid)
        clear_heartbeat(uid)
        return 0
    return n


def is_online(uid) -> bool:
    return bool(_r.sismember(ONLINE_SET, str(uid)))


def online_user_ids() -> set:
    return set(_r.smembers(ONLINE_SET))


# --- heartbeat (страховка от «призрачных» сессий) ---------------------------
# GatewayConsumer.disconnect() чисто прибирает presence, когда WS закрылся
# нормально (close-фрейм дошёл). Но если сеть оборвалась резко (сон ноутбука,
# краш вкладки, вырубленный вайфай/VPN) — close-фрейм может не прийти вообще,
# и без этой страховки uid оставался бы «онлайн в голосе» бессрочно. Клиент
# шлёт {"op": "ping"} раз в несколько минут, пока держит /ws/gateway открытым
# (см. gateway.tsx); сервер обновляет этот TTL. Отдельный периодический sweep
# (см. [[heartbeat_sweep]]) находит тех, у кого TTL истёк, и принудительно
# считает их отключившимися.
def heartbeat(uid) -> bool:
    """Обновляет TTL «жив». Возвращает True, если пользователя пришлось
    ВЕРНУТЬ в online.

    Так бывает, когда пинг задержался дольше HEARTBEAT_TTL (спящая вкладка,
    длинный сетевой провал, троттлинг фонового таба) и sweep успел счесть
    сокет призраком, хотя тот жив. Раньше heartbeat трогал только TTL, и
    такой пользователь оставался офлайн для всех до самого переподключения —
    вечно, сколько бы пингов ни пришло. Вызывающий обязан при True заново
    разослать presence (см. GatewayConsumer, op "ping").
    """
    uid = str(uid)
    _r.set(_heartbeat_key(uid), 1, ex=HEARTBEAT_TTL)
    if _r.sismember(ONLINE_SET, uid):
        return False
    _r.sadd(ONLINE_SET, uid)
    # Счётчик коннектов sweep обнулил. Восстанавливаем как «один сокет»: если
    # их на самом деле было несколько, лишние узнают о себе на своём же
    # следующем пинге (не позже минуты) — самовосстанавливается.
    _r.setnx(_conn_key(uid), 1)
    return True


def is_heartbeat_alive(uid) -> bool:
    return bool(_r.exists(_heartbeat_key(str(uid))))


def clear_heartbeat(uid):
    _r.delete(_heartbeat_key(str(uid)))


def force_offline(uid):
    """Принудительно считает uid полностью отключившимся — для sweep'а, когда
    обычный disconnect() так и не пришёл. Возвращает голосовой канал, который
    он покидает (или None), чтобы вызывающий код разослал уведомление."""
    uid = str(uid)
    _r.delete(_conn_key(uid))
    _r.srem(ONLINE_SET, uid)
    prev = clear_voice(uid)
    clear_heartbeat(uid)
    return prev


# --- voice ------------------------------------------------------------------
def set_voice(uid, channel_id):
    """Ставит пользователя в голосовой канал. Возвращает предыдущий канал."""
    uid = str(uid)
    channel_id = str(channel_id)
    prev = _r.get(_voice_key(uid))
    if prev and prev != channel_id:
        _r.srem(_voice_members_key(prev), uid)
    _r.set(_voice_key(uid), channel_id)
    _r.sadd(_voice_members_key(channel_id), uid)
    return prev


def join_voice(uid, channel_id, connection_id=None):
    """Атомарно ставит пользователя в голосовой канал.

    connection_id — какое именно WS-соединение (вкладка/устройство) это
    сделало; см. voice_owner/is_voice_owner ниже и GatewayConsumer.disconnect
    в consumers.py: аккаунт может быть в голосе только с ОДНОГО устройства
    разом (см. _kick_other_devices), поэтому именно ЭТО соединение и должно
    выходить из голоса при своём обрыве — не когда закроется последняя
    вкладка аккаунта вообще (тех, что не при голосе, может быть открыто
    сколько угодно). Опционален и по умолчанию не трогается — это чисто
    сервисная метка, часть публичного API join_voice не расширяет для тех,
    кому она не нужна (тесты, heartbeat_sweep).

    Возвращает (peers, emptied_channel):
    - peers — id участников, которые уже были в канале ДО этого вызова
      (используется как список пиров для инициации WebRTC-соединений);
    - emptied_channel — id канала, который пользователь только что покинул
      переключением (если тот в итоге опустел), иначе None.
    """
    uid = str(uid)
    channel_id = str(channel_id)
    prev = _r.get(_voice_key(uid))
    peers = _join_voice(
        keys=[_voice_key(uid), _voice_members_key(channel_id)],
        args=[uid, channel_id],
    )
    peers = [p for p in peers if p != uid]

    if connection_id is not None:
        _r.set(_voice_owner_key(uid), connection_id)

    emptied_channel = None
    if prev and prev != channel_id and not _r.scard(_voice_members_key(prev)):
        _clear_call_state(prev)
        emptied_channel = prev

    if not peers:
        # Мы первые в канале — начинается новый разговор.
        _r.set(_call_started_key(channel_id), time.time(), nx=True)

    return peers, emptied_channel


def clear_voice(uid):
    uid = str(uid)
    prev = _r.get(_voice_key(uid))
    if prev:
        _r.srem(_voice_members_key(prev), uid)
        _r.delete(_voice_key(uid))
        if not _r.scard(_voice_members_key(prev)):
            _clear_call_state(prev)
    _r.delete(_voice_flags_key(uid))
    _r.delete(_voice_owner_key(uid))
    return prev


def voice_channel(uid):
    return _r.get(_voice_key(str(uid)))


def is_voice_owner(uid, connection_id) -> bool:
    """Это ли соединение сейчас "владеет" голосом пользователя — см.
    join_voice/GatewayConsumer.disconnect. connection_id пустой/None (клиент
    почему-то не прислал device_id) никогда не считается владельцем —
    иначе два таких соединения подряд ложно совпали бы друг с другом."""
    if not connection_id:
        return False
    return _r.get(_voice_owner_key(str(uid))) == connection_id


def voice_member_ids(channel_id) -> set:
    return set(_r.smembers(_voice_members_key(channel_id)))


# --- status -------------------------------------------------------------
def effective_status(user, online: bool) -> str:
    """Что видят ДРУГИЕ пользователи.

    Не подключён -> всегда "offline". "invisible" маскируется под "offline"
    (в этом весь смысл невидимки — реальное online-состояние не палим).
    "dnd" и "online" видны как есть.
    """
    if not online:
        return "offline"
    if user.status == user.INVISIBLE:
        return "offline"
    return user.status


# --- voice mic/deafen/screen-share флаги ---------------------------------
def set_voice_flags(uid, muted: bool, deafened: bool):
    """Запоминает состояние микрофона/наушников — чтобы новый участник канала
    сразу видел актуальный статус остальных, не дожидаясь их следующего
    voice_mute_update."""
    _r.hset(_voice_flags_key(str(uid)), mapping={
        "muted": int(bool(muted)), "deafened": int(bool(deafened)),
    })


def set_screen_sharing(uid, sharing: bool):
    """Отдельно от muted/deafened — демонстрация экрана. Хранится в том же
    хэше (hset с частичным mapping не трогает остальные поля), поэтому
    живёт наравне с ними и точно так же стирается clear_voice() при выходе
    из канала. Виден ВСЕМ на сервере (не только участникам SFU-комнаты) —
    именно на этом флаге строится бейдж «демка» и клик по нему."""
    _r.hset(_voice_flags_key(str(uid)), mapping={
        "sharing_screen": int(bool(sharing)),
    })


def voice_flags(uid) -> dict:
    raw = _r.hgetall(_voice_flags_key(str(uid)))
    return {
        "muted": raw.get("muted") == "1",
        "deafened": raw.get("deafened") == "1",
        "sharing_screen": raw.get("sharing_screen") == "1",
    }


def voice_members_flags(channel_id) -> dict:
    return {uid: voice_flags(uid) for uid in voice_member_ids(channel_id)}


def members_snapshot(uids) -> dict:
    """Онлайн/голос/флаги для пачки пользователей ОДНИМ пайплайном.

    Поштучные is_online + voice_channel + voice_flags давали три
    последовательных round-trip'а к Redis на каждого участника — то есть
    O(3N) на один HTTP-запрос списка участников (см. chat.views.ServerMembers).
    """
    uids = [str(u) for u in uids]
    if not uids:
        return {}
    pipe = _r.pipeline(transaction=False)
    for uid in uids:
        pipe.sismember(ONLINE_SET, uid)
        pipe.get(_voice_key(uid))
        pipe.hgetall(_voice_flags_key(uid))
    raw = pipe.execute()
    snapshot = {}
    for index, uid in enumerate(uids):
        online, voice, flags = raw[index * 3:index * 3 + 3]
        flags = flags or {}
        snapshot[uid] = {
            "online": bool(online),
            "voice_channel": voice,
            "muted": flags.get("muted") == "1",
            "deafened": flags.get("deafened") == "1",
            "sharing_screen": flags.get("sharing_screen") == "1",
        }
    return snapshot


def call_states(channel_ids) -> dict:
    """call_started_at/topic для пачки каналов одним пайплайном — иначе
    сериализация сервера дёргает Redis дважды на каждый голосовой канал
    (см. chat.serializers.ChannelSerializer)."""
    channel_ids = [str(c) for c in channel_ids]
    if not channel_ids:
        return {}
    pipe = _r.pipeline(transaction=False)
    for channel_id in channel_ids:
        pipe.get(_call_started_key(channel_id))
        pipe.get(_call_topic_key(channel_id))
    raw = pipe.execute()
    states = {}
    for index, channel_id in enumerate(channel_ids):
        started, topic = raw[index * 2:index * 2 + 2]
        states[channel_id] = {
            "call_started_at": float(started) if started is not None else None,
            "topic": topic,
        }
    return states


# --- call state (длительность разговора + статус канала) --------------------
def _clear_call_state(channel_id):
    _r.delete(_call_started_key(channel_id))
    _r.delete(_call_topic_key(channel_id))


def call_started_at(channel_id):
    """Unix-время (float, секунды) начала текущего разговора, либо None."""
    val = _r.get(_call_started_key(str(channel_id)))
    return float(val) if val is not None else None


def call_topic(channel_id):
    return _r.get(_call_topic_key(str(channel_id)))


def set_call_topic(channel_id, topic: str | None):
    """Тему может ставить только тот, кто сейчас в канале (проверяется
    вызывающей стороной через voice_channel(uid)). Пустая/None — очищает."""
    channel_id = str(channel_id)
    if topic:
        _r.set(_call_topic_key(channel_id), topic)
    else:
        _r.delete(_call_topic_key(channel_id))


def call_state(channel_id) -> dict:
    return {
        "call_started_at": call_started_at(channel_id),
        "topic": call_topic(channel_id),
    }


# --- голосование за мут -------------------------------------------------
# Один активный голос на канал одновременно (см. start_mute_vote). Ключ
# голосования сам себе TTL (несколько секунд запаса сверх длительности) —
# страховка на случай, если ни cast (резолвит сразу, когда все проголосовали),
# ни периодический vote_sweep (резолвит по истечении ends_at) почему-то не
# отработают; без этого зависший голос держал бы канал в ACTIVE_VOTES_SET
# бессрочно.
ACTIVE_VOTES_SET = "presence:active_votes"


def _vote_key(channel_id) -> str:
    return f"presence:vote:{channel_id}"


def _vote_for_key(channel_id) -> str:
    return f"presence:vote:{channel_id}:for"


def _vote_against_key(channel_id) -> str:
    return f"presence:vote:{channel_id}:against"


def _forced_mute_key(uid) -> str:
    return f"presence:forced_mute:{uid}"


def start_mute_vote(channel_id, target_uid, initiator_uid, duration_s: float) -> bool:
    """Заводит голосование за мут в канале. False, если там уже идёт другое."""
    channel_id = str(channel_id)
    key = _vote_key(channel_id)
    if _r.exists(key):
        return False
    now = time.time()
    ends_at = now + duration_s
    _r.hset(key, mapping={
        "target_uid": str(target_uid),
        "initiator_uid": str(initiator_uid),
        "started_at": now,
        "ends_at": ends_at,
    })
    _r.expire(key, int(duration_s) + 30)
    _r.sadd(ACTIVE_VOTES_SET, channel_id)
    return True


def active_mute_vote(channel_id) -> dict | None:
    raw = _r.hgetall(_vote_key(str(channel_id)))
    if not raw:
        return None
    return {
        "target_uid": raw["target_uid"],
        "initiator_uid": raw["initiator_uid"],
        "started_at": float(raw["started_at"]),
        "ends_at": float(raw["ends_at"]),
    }


def cast_mute_vote(channel_id, uid, for_: bool) -> bool:
    """Засчитывает голос. False — если голосования нет или uid уже голосовал."""
    channel_id = str(channel_id)
    uid = str(uid)
    if not _r.exists(_vote_key(channel_id)):
        return False
    if _r.sismember(_vote_for_key(channel_id), uid) or _r.sismember(
        _vote_against_key(channel_id), uid
    ):
        return False
    _r.sadd(_vote_for_key(channel_id) if for_ else _vote_against_key(channel_id), uid)
    return True


def mute_vote_tally(channel_id) -> tuple[set, set]:
    channel_id = str(channel_id)
    return (
        _r.smembers(_vote_for_key(channel_id)),
        _r.smembers(_vote_against_key(channel_id)),
    )


def mute_vote_eligible_ids(channel_id, target_uid) -> set:
    """Кто может голосовать — все, кто сейчас в канале, кроме самой цели."""
    ids = voice_member_ids(channel_id)
    ids.discard(str(target_uid))
    return ids


# Атомарно забрать голосование вместе с тэлли и стереть его. Резолв дёргают
# два независимых места — consumers (когда проголосовали все) и vote_sweep (по
# истечении ends_at, опрос раз в 2с). Раньше между «прочитали» и «удалили» был
# зазор, и совпадение по времени давало двойную рассылку результата: двойной
# мут и дубли событий у всех клиентов.
_CLAIM_MUTE_VOTE_SCRIPT = """
local vote = redis.call('HGETALL', KEYS[1])
if #vote == 0 then return nil end
local votes_for = redis.call('SMEMBERS', KEYS[2])
local votes_against = redis.call('SMEMBERS', KEYS[3])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return {vote, votes_for, votes_against}
"""
_claim_mute_vote = _r.register_script(_CLAIM_MUTE_VOTE_SCRIPT)


def claim_mute_vote(channel_id):
    """Забрать активное голосование канала — ровно один вызывающий получит
    данные, все остальные (None, set(), set()). См. скрипт выше."""
    channel_id = str(channel_id)
    raw = _claim_mute_vote(
        keys=[
            _vote_key(channel_id),
            _vote_for_key(channel_id),
            _vote_against_key(channel_id),
            ACTIVE_VOTES_SET,
        ],
        args=[channel_id],
    )
    if not raw:
        return None, set(), set()
    flat, votes_for, votes_against = raw
    fields = dict(zip(flat[::2], flat[1::2]))
    vote = {
        "target_uid": fields["target_uid"],
        "initiator_uid": fields["initiator_uid"],
        "started_at": float(fields["started_at"]),
        "ends_at": float(fields["ends_at"]),
    }
    return vote, set(votes_for), set(votes_against)


def clear_mute_vote(channel_id):
    channel_id = str(channel_id)
    _r.delete(
        _vote_key(channel_id), _vote_for_key(channel_id), _vote_against_key(channel_id))
    _r.srem(ACTIVE_VOTES_SET, channel_id)


def active_vote_channel_ids() -> set:
    return set(_r.smembers(ACTIVE_VOTES_SET))


# --- принудительный мут (итог голосования) -------------------------------
def set_forced_mute(uid, until_ts: float):
    ttl = max(1, int(until_ts - time.time()))
    _r.set(_forced_mute_key(str(uid)), until_ts, ex=ttl)


def forced_mute_until(uid):
    val = _r.get(_forced_mute_key(str(uid)))
    return float(val) if val is not None else None


def clear_forced_mute(uid):
    _r.delete(_forced_mute_key(str(uid)))
