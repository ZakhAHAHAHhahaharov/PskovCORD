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


def blocked_user_ids(user) -> set:
    """Кого ЭТОТ пользователь заблокировал (см. chat.models.UserRelationState).

    Возвращает множество id — вызывающие фильтруют им ленту сообщений одним
    проходом, без запроса на каждого автора.
    """
    from .models import UserRelationState

    return set(
        UserRelationState.objects.filter(user=user, blocked=True).values_list(
            "target_id", flat=True)
    )


def has_blocked(user, target) -> bool:
    """Заблокировал ли user именно target'а."""
    from .models import UserRelationState

    return UserRelationState.objects.filter(
        user=user, target=target, blocked=True).exists()


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

    Блокировка сильнее всех разрешений разом: заблокировавший не получит
    новую личку от заблокированного, даже если они друзья и стоит
    dm_privacy=EVERYONE.
    """
    if sender.id == recipient.id:
        return False
    if has_blocked(recipient, sender):
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


def can_see_channel(user, channel, perms=None) -> bool:
    """Виден ли пользователю ЭТОТ канал.

    Публичный канал — по обычному view_channels. Приватный (Channel.is_private)
    им НЕ открывается: нужен либо manage_channels (тот, кто заводит каналы,
    обязан видеть все — иначе он мог бы создать канал и тут же потерять к нему
    доступ), либо роль из Channel.allowed_roles, либо личный допуск в
    Channel.allowed_users (см. вкладка «Права доступа» в ChannelSettingsModal —
    доступ дают ролью И/ИЛИ конкретным человеком, это не взаимоисключающе).

    perms — уже посчитанные права (chat.roles.permissions_for), если они есть
    у вызывающего: эта функция зовётся в цикле по каналам сервера, и считать
    их заново на каждый канал значило бы пару запросов на канал.
    """
    from . import roles as roles_module
    from .models import Membership

    if perms is None:
        perms = roles_module.permissions_for(user, channel.server)
    if not perms.get("view_channels"):
        return False
    if not channel.is_private:
        return True
    if perms.get("manage_channels"):
        return True
    if channel.allowed_users.filter(id=user.id).exists():
        return True
    membership = Membership.objects.filter(
        user=user, server_id=channel.server_id).prefetch_related("roles").first()
    if membership is None:
        return False
    allowed = set(channel.allowed_roles.values_list("id", flat=True))
    return any(role.id in allowed for role in membership.roles.all())


def visible_channels(user, server, channels=None) -> list:
    """Каналы сервера, которые пользователю можно показывать. Права считаются
    ОДИН раз на весь список (см. can_see_channel)."""
    from . import roles as roles_module

    perms = roles_module.permissions_for(user, server)
    if channels is None:
        channels = server.channels.all()
    return [c for c in channels if can_see_channel(user, c, perms)]
