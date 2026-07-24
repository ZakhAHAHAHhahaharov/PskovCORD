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
def heartbeat(uid):
    _r.set(_heartbeat_key(str(uid)), 1, ex=HEARTBEAT_TTL)


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


def join_voice(uid, channel_id):
    """Атомарно ставит пользователя в голосовой канал.

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
    return prev


def voice_channel(uid):
    return _r.get(_voice_key(str(uid)))


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
