"""
Фоновый sweep голосований "заглушить участника", вышедших за отведённое время.

Голосование обычно резолвится само (см. GatewayConsumer._handle_voice_mute_vote_cast),
как только проголосуют все, кто имеет право голоса. Но если кто-то так и не
проголосовал (вышел из канала, просто не отреагировал) — голосование иначе
висело бы бессрочно (TTL ключа в Redis — просто страховка, сам он ничего не
рассылает). Раз в SWEEP_INTERVAL проверяем все каналы с активным голосованием
(presence.active_vote_channel_ids) и резолвим те, чей ends_at уже прошёл, той
же логикой (chat.mute_vote.resolve), что и обычное досрочное завершение.

Зеркало [[heartbeat_sweep]] — тот же паттерн: daemon-поток, close_old_connections()
перед каждой итерацией (это единственный несинхронизированный с Channels
поток, трогающий Django ORM, — стандартные connection'ы по потоку могут
протухнуть между итерациями).
"""
import logging
import threading
import time

from channels.layers import get_channel_layer
from django.db import close_old_connections

from . import mute_vote, presence

logger = logging.getLogger(__name__)

SWEEP_INTERVAL = 2  # секунд — голосование короткое (20с), sweep должен быть чаще heartbeat'а


def _sweep_once():
    close_old_connections()
    channel_layer = get_channel_layer()
    now = time.time()
    for channel_id in presence.active_vote_channel_ids():
        vote = presence.active_mute_vote(channel_id)
        if not vote or vote["ends_at"] > now:
            continue
        try:
            mute_vote.resolve(channel_id, channel_layer)
        except Exception:
            logger.exception("vote sweep: ошибка резолва голосования channel_id=%s", channel_id)


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
                logger.exception("vote sweep: ошибка итерации")

    threading.Thread(target=loop, name="mute-vote-sweep", daemon=True).start()
