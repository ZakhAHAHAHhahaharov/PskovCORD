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
    chat.models.Conversation) — только на создание нового.

    dm_privacy=NOBODY — абсолютный запрет, даже друзьям и даже через общий
    сервер: «никто» здесь значит никто, без исключений. dm_privacy=FRIENDS
    получает ОДНО исключение — общий сервер, на котором получатель включил
    личную настройку «Личные сообщения» (Membership.allow_dms_from_server,
    см. chat.models) — так участник сервера может написать даже не будучи
    другом, если получатель сам это разрешил именно для этого сервера.
    """
    if sender.id == recipient.id:
        return False
    if recipient.dm_privacy == recipient.DM_NOBODY:
        return False
    if recipient.dm_privacy == recipient.DM_EVERYONE:
        return True
    if are_friends(sender, recipient):
        return True
    return _shares_server_allowing_dms(sender, recipient)


def _shares_server_allowing_dms(sender, recipient) -> bool:
    from .models import Membership

    sender_server_ids = Membership.objects.filter(user=sender).values_list(
        "server_id", flat=True)
    return Membership.objects.filter(
        user=recipient, server_id__in=sender_server_ids,
        allow_dms_from_server=True,
    ).exists()
