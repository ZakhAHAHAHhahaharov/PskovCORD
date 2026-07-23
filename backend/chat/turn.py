"""
Выдача TURN/STUN credentials для собственного coturn (REST shared-secret,
стандартная long-term credential схема coturn: --use-auth-secret).
"""
import base64
import hashlib
import hmac
import time

from django.conf import settings


def _credentials(user_id, ttl: int) -> tuple[str, str]:
    username = f"{int(time.time()) + ttl}:{user_id}"
    digest = hmac.new(
        settings.TURN_SECRET.encode(), username.encode(), hashlib.sha1
    ).digest()
    return username, base64.b64encode(digest).decode()


def ice_servers(user_id, ttl: int = 3600) -> list:
    username, credential = _credentials(user_id, ttl)
    host = settings.TURN_HOST
    port = settings.TURN_PORT
    return [
        {"urls": [f"stun:{host}:{port}"]},
        {
            "urls": [
                f"turn:{host}:{port}?transport=udp",
                f"turn:{host}:{port}?transport=tcp",
            ],
            "username": username,
            "credential": credential,
        },
    ]
