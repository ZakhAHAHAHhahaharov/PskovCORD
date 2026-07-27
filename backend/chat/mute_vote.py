"""
Резолюция голосования "заглушить участника" — общая логика, вызываемая и из
GatewayConsumer (когда все имеющие право голоса уже проголосовали, раньше
таймаута), и из периодического vote_sweep (когда голосование истекло по
времени — см. vote_sweep.py). Обе стороны сами решают, как её звать
(GatewayConsumer — через database_sync_to_async, vote_sweep — напрямую, он и
так работает в отдельном синхронном потоке); сама функция ничего не знает про
async и работает с Django ORM/Redis синхронно.
"""
import time

from asgiref.sync import async_to_sync

from . import presence

MUTE_VOTE_DURATION_S = 20
FORCED_MUTE_DURATION_S = 10 * 60


def resolve(channel_id, channel_layer):
    """Читает тэлли активного голосования канала и завершает его: побеждает
    "ЗА" только строго больше "ПРОТИВ" (равенство — не мутим). Победа —
    форс-мут цели на FORCED_MUTE_DURATION_S секунд, разослан всем через
    voice_mute_update (тот же индикатор, что и обычный мьют) плюс персонально
    самой цели voice_forced_mute (клиент реально глушит свой микрофон и не
    даёт размьютиться раньше срока). Безопасно вызывать, даже если
    голосования уже нет (например, гонка между cast() и sweep'ом), — тогда
    просто ничего не делает."""
    from .models import Channel

    # Забираем голосование атомарно: прочитать-и-стереть одним движением.
    # Раньше здесь было read → tally → clear тремя отдельными операциями, и
    # если последний голос приходил ровно к ends_at, consumers и vote_sweep
    # успевали оба прочитать ещё не стёртые данные — результат рассылался
    # дважды (двойной мут, дубли событий у всех клиентов).
    vote, votes_for, votes_against = presence.claim_mute_vote(channel_id)
    if not vote:
        return

    target_uid = vote["target_uid"]

    try:
        server_id = Channel.objects.get(id=channel_id).server_id
    except Channel.DoesNotExist:
        return

    muted = len(votes_for) > len(votes_against)
    until = None
    if muted:
        until = time.time() + FORCED_MUTE_DURATION_S
        presence.set_forced_mute(target_uid, until)
        current_flags = presence.voice_flags(target_uid)
        presence.set_voice_flags(target_uid, True, current_flags["deafened"])

    async_to_sync(channel_layer.group_send)(
        f"server_{server_id}", {"type": "broadcast", "payload": {
            "op": "voice_mute_vote_result",
            "channel_id": int(channel_id),
            "target_user_id": int(target_uid),
            "muted": muted,
            "votes_for": len(votes_for),
            "votes_against": len(votes_against),
        }})

    if not muted:
        return

    async_to_sync(channel_layer.group_send)(
        f"server_{server_id}", {"type": "broadcast", "payload": {
            "op": "voice_mute_update",
            "user_id": int(target_uid),
            "muted": True,
            "deafened": current_flags["deafened"],
        }})
    async_to_sync(channel_layer.group_send)(
        f"user_{target_uid}", {"type": "broadcast", "payload": {
            "op": "voice_forced_mute",
            "until": until,
        }})
