"""
Выдача access-токена для собственного SFU (mediasoup Node-сервис).

Токен подписывается общим секретом SFU_SECRET (HS256); Node-сервис его
верифицирует и берёт из него, кто (uid) и в какой voice-канал (room) заходит.
Аналог схемы с TURN REST-secret ([turn.py]) — единый секрет между Django и
медиа-сервером, короткий TTL.
"""
import time

import jwt
from django.conf import settings

# Час был слишком много: пока токен жив, забаненный/лишённый права участник
# по нему всё ещё попадает на медиа-лег (SFU не ходит в Django и о правах
# узнаёт только из токена). Клиент перезапрашивает credentials на каждой
# попытке подключения, так что короткий TTL ему ничего не стоит, а окно
# «права отозвали, а он ещё говорит» сжимается с часа до нескольких минут.
DEFAULT_TTL = 5 * 60


def access_token(
    user_id,
    channel_id,
    username: str = "",
    ttl: int = DEFAULT_TTL,
    *,
    can_speak: bool = True,
    can_video: bool = True,
) -> str:
    """can_speak/can_video — права роли (chat.roles) в момент выдачи токена.

    SFU не ходит в Django и о ролях не знает, поэтому право «Показывать
    видео» проверять больше негде: единственная точка, где демонстрация
    экрана становится реальной, — produce на SFU. Права едут в самом токене
    и там же проверяются (см. sfu/src/signaling.ts). Для звонков в личке и
    группах ролей нет — там оба флага всегда True.

    Токен короткоживущий (см. DEFAULT_TTL): он же служит окном, за которое
    отзыв прав/бан догоняет уже подключённого участника — клиент
    перезапрашивает credentials при каждом переподключении к SFU.
    """
    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "uid": int(user_id),
        "room": str(channel_id),
        "name": username,
        "speak": bool(can_speak),
        "video": bool(can_video),
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, settings.SFU_SECRET, algorithm="HS256")
