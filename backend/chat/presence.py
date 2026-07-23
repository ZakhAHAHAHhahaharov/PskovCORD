"""
Presence через Redis.

- online: пользователь считается онлайн, пока у него есть хотя бы одно
  активное WebSocket-подключение (счётчик коннектов на юзера).
- voice: в каком голосовом канале сейчас находится пользователь.
"""
import redis
from django.conf import settings

_r = redis.from_url(settings.REDIS_URL, decode_responses=True)

ONLINE_SET = "presence:online"


def _conn_key(uid) -> str:
    return f"presence:conns:{uid}"


def _voice_key(uid) -> str:
    return f"presence:voice:{uid}"


def _voice_members_key(channel_id) -> str:
    return f"voice:{channel_id}"


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
        return 0
    return n


def is_online(uid) -> bool:
    return bool(_r.sismember(ONLINE_SET, str(uid)))


def online_user_ids() -> set:
    return set(_r.smembers(ONLINE_SET))


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


def clear_voice(uid):
    uid = str(uid)
    prev = _r.get(_voice_key(uid))
    if prev:
        _r.srem(_voice_members_key(prev), uid)
        _r.delete(_voice_key(uid))
    return prev


def voice_channel(uid):
    return _r.get(_voice_key(str(uid)))


def voice_member_ids(channel_id) -> set:
    return set(_r.smembers(_voice_members_key(channel_id)))
