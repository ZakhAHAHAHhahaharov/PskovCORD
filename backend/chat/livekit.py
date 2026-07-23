"""
Генерация LiveKit access-токенов на бэке (SFU руками не трогаем).

LiveKit принимает стандартный JWT (HS256), подписанный API-секретом,
с claim `video` (camelCase-ключи грантов).
"""
import time

import jwt
from django.conf import settings


def create_access_token(identity: str, name: str, room: str, ttl: int = 3600) -> str:
    now = int(time.time())
    payload = {
        "iss": settings.LIVEKIT_API_KEY,
        "sub": identity,
        "name": name,
        "nbf": now,
        "iat": now,
        "exp": now + ttl,
        "video": {
            "roomJoin": True,
            "room": room,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        },
    }
    return jwt.encode(payload, settings.LIVEKIT_API_SECRET, algorithm="HS256")


def room_name(channel_id) -> str:
    return f"channel_{channel_id}"
