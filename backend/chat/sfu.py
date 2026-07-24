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


def access_token(user_id, channel_id, username: str = "", ttl: int = 3600) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "uid": int(user_id),
        "room": str(channel_id),
        "name": username,
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, settings.SFU_SECRET, algorithm="HS256")
