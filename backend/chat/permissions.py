"""Общие проверки доступа для ЛС/друзей — используются и в chat/views.py
(REST), и в chat/consumers.py (через database_sync_to_async), чтобы не
дублировать логику в двух местах."""
from django.db.models import Q

from accounts.models import Friendship


def are_friends(a, b) -> bool:
    if a.id == b.id:
        return True
    return Friendship.objects.filter(status=Friendship.ACCEPTED).filter(
        Q(from_user=a, to_user=b) | Q(from_user=b, to_user=a)
    ).exists()


def can_dm(sender, recipient) -> bool:
    """Может ли sender НАЧАТЬ личку с recipient — смотрит на dm_privacy
    получателя. Не действует на уже существующие диалоги (см.
    chat.models.Conversation) — только на создание нового."""
    if sender.id == recipient.id:
        return False
    if recipient.dm_privacy == recipient.DM_NOBODY:
        return False
    if recipient.dm_privacy == recipient.DM_FRIENDS:
        return are_friends(sender, recipient)
    return True  # DM_EVERYONE
