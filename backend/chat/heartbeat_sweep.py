"""
Фоновый sweep «призрачных» presence-записей.

GatewayConsumer.disconnect() чисто убирает пользователя из online/voice, когда
WebSocket закрылся нормально. Но если TCP-соединение оборвалось без close-
фрейма (сон ноутбука, краш вкладки, вырубленный вайфай/VPN), disconnect()
может не прийти вообще — и без этой страховки такой uid оставался бы
«онлайн в голосовом канале» бессрочно.

Раз в SWEEP_INTERVAL проверяем всех, кто сейчас числится online, — и для тех,
чей heartbeat (см. presence.heartbeat, обновляется на {"op": "ping"} от
клиента, см. gateway.tsx) истёк, принудительно считаем их отключившимися:
чистим presence и рассылаем те же события, что разослал бы настоящий
disconnect() (voice_state_update/voice_call_state, если они были в голосе).
"""
import logging
import threading
import time

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import close_old_connections

from . import presence

logger = logging.getLogger(__name__)

SWEEP_INTERVAL = 60  # секунд


def _sweep_once():
    close_old_connections()
    channel_layer = get_channel_layer()
    for uid in presence.online_user_ids():
        if presence.is_heartbeat_alive(uid):
            continue
        # try/except на КАЖДЫЙ uid, а не на проход целиком: раньше одно
        # исключение срывало всю итерацию, и остальные призраки оставались
        # «онлайн» до следующей минуты — и так по кругу, пока проблемная
        # запись не исчезнет сама.
        try:
            _force_disconnect_uid(uid, channel_layer)
        except Exception:
            logger.exception("presence sweep: не удалось отключить uid=%s", uid)


def _force_disconnect_uid(uid, channel_layer):
    from accounts.models import User  # локальные импорты — без циклов при старте приложения
    from .models import Channel, Membership, dm_conversation_id, is_dm_room

    prev_voice = presence.force_offline(uid)
    logger.info("presence sweep: uid=%s признан отключённым (heartbeat истёк)", uid)

    try:
        user = User.objects.get(id=uid)
    except User.DoesNotExist:
        return

    # presence_update — как настоящий disconnect(), всем серверам пользователя
    # сразу, а не только тому, где была голосовая активность.
    presence_payload = {
        "op": "presence_update",
        "user_id": user.id,
        "username": user.username,
        "avatar_color": user.avatar_color,
        "avatar_image": user.avatar_image,
        "online": False,
        "status": "offline",
    }
    for server_id in Membership.objects.filter(user=user).values_list(
        "server_id", flat=True
    ):
        async_to_sync(channel_layer.group_send)(
            f"server_{server_id}", {"type": "broadcast", "payload": presence_payload}
        )

    if not prev_voice:
        return

    # Комната могла быть звонком в личке/группе — presence хранит её как
    # непрозрачную строку вида "dm_<conversation_id>" и сервер от диалога не
    # отличает (см. models.is_dm_room). Раньше эта строка уходила прямо в
    # Channel.objects.get(id=...), где целочисленное поле бросало ValueError
    # (не DoesNotExist!) — он пролетал мимо except и срывал весь проход
    # sweep'а, а участники звонка так и не узнавали, что собеседник отвалился:
    # он висел в разговоре бессрочно.
    if is_dm_room(prev_voice):
        conversation_id = dm_conversation_id(prev_voice)
        async_to_sync(channel_layer.group_send)(
            f"conversation_{conversation_id}",
            {"type": "broadcast", "payload": {
                "op": "dm_voice_state_update",
                "user_id": user.id,
                "username": user.username,
                "avatar_color": user.avatar_color,
                "avatar_image": user.avatar_image,
                "conversation_id": conversation_id,
                "in_call": False,
            }},
        )
        return

    try:
        server_id = Channel.objects.get(id=prev_voice).server_id
    except (Channel.DoesNotExist, ValueError, TypeError):
        return

    state = presence.call_state(prev_voice)
    voice_payloads = [
        {
            "op": "voice_state_update",
            "user_id": user.id,
            "username": user.username,
            "avatar_color": user.avatar_color,
            "channel_id": None,
            "server_id": server_id,
        },
        {
            "op": "voice_call_state",
            "channel_id": int(prev_voice),
            "call_started_at": state["call_started_at"],
            "topic": state["topic"],
        },
    ]
    for payload in voice_payloads:
        async_to_sync(channel_layer.group_send)(
            f"server_{server_id}", {"type": "broadcast", "payload": payload}
        )


_started = False
_lock = threading.Lock()


def start():
    """Запускает фоновый поток-sweep один раз на процесс. Безопасно вызывать
    многократно (например, из ready() при автоперезагрузке runserver)."""
    global _started
    with _lock:
        if _started:
            return
        _started = True

    def loop():
        while True:
            time.sleep(SWEEP_INTERVAL)
            try:
                _sweep_once()
            except Exception:
                logger.exception("presence sweep: ошибка итерации")

    threading.Thread(target=loop, name="presence-heartbeat-sweep", daemon=True).start()
