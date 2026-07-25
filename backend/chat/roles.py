"""Права ролей сервера — единственный источник правды о том, какие права
вообще бывают и как они складываются у конкретного участника.

Используется и REST-вьюхами (chat/views.py), и WS-консьюмером
(chat/consumers.py через database_sync_to_async), и сериализаторами — чтобы
список прав не расползался копиями по проекту. Соответствующие булевы поля
живут на chat.models.Role; при добавлении права правьте оба места.
"""

# (поле модели Role, человекочитаемое название, группа для UI редактора)
PERMISSION_FIELDS = [
    ("view_channels", "Просматривать каналы", "general"),
    ("manage_channels", "Управлять каналами", "general"),
    ("manage_roles", "Управлять ролями", "general"),
    ("manage_server", "Управлять сервером", "general"),
    ("manage_invites", "Управлять приглашениями", "general"),
    ("manage_nicknames", "Управлять никнеймами", "general"),
    ("manage_members", "Выгонять/одобрять/банить участников", "general"),

    ("send_messages", "Отправка сообщений", "text"),
    ("delete_messages", "Удаление сообщений", "text"),
    ("mention_everyone", "Упоминания @all / @online / @here", "text"),

    ("speak", "Говорить", "voice"),
    ("video", "Показывать видео", "voice"),
]

PERMISSION_NAMES = [field for field, _label, _group in PERMISSION_FIELDS]

# Права рядового участника — то, с чем создаётся роль по умолчанию (совпадает
# с дефолтами полей chat.models.Role) и то, что действует, если роли по
# умолчанию на сервере почему-то нет вообще (удалили через админку, сервер
# создан скриптом мимо API). Без этого запаса участники такого сервера
# молча теряли бы даже возможность писать.
BASE_MEMBER_PERMISSIONS = {
    "view_channels", "send_messages", "speak", "video",
}


def all_permissions() -> dict:
    """Полный набор прав — то, что есть у владельца сервера."""
    return {name: True for name in PERMISSION_NAMES}


def no_permissions() -> dict:
    return {name: False for name in PERMISSION_NAMES}


def base_member_permissions() -> dict:
    return {name: name in BASE_MEMBER_PERMISSIONS for name in PERMISSION_NAMES}


def permissions_for(user, server) -> dict:
    """Итоговые права участника на сервере: объединение (OR) прав роли по
    умолчанию и всех выданных ему ролей. Владелец сервера всегда получает
    всё — иначе он мог бы случайно лишить себя доступа к собственному
    серверу, отредактировав роль по умолчанию.

    Не участник сервера прав не имеет вообще (даже прав роли по умолчанию).
    """
    from .models import Membership, Role

    if not user or not user.is_authenticated:
        return no_permissions()
    if server.owner_id == user.id:
        return all_permissions()

    membership = Membership.objects.filter(
        user=user, server=server).prefetch_related("roles").first()
    if membership is None:
        return no_permissions()

    roles = list(membership.roles.all())
    default_role = Role.objects.filter(server=server, is_default=True).first()
    if default_role is not None:
        roles.append(default_role)

    # Роли по умолчанию нет — считаем участника рядовым (см.
    # BASE_MEMBER_PERMISSIONS), а не бесправным.
    result = no_permissions() if default_role is not None else base_member_permissions()
    for role in roles:
        for name in PERMISSION_NAMES:
            if getattr(role, name, False):
                result[name] = True
    return result


def has_permission(user, server, permission: str) -> bool:
    return permissions_for(user, server).get(permission, False)


def create_default_role(server):
    """Роль «Участник» — выдаётся при создании сервера, действует на всех.
    Дефолты полей Role уже описывают базового участника (читать каналы,
    писать, говорить, показывать видео), поэтому ничего не переопределяем."""
    from .models import Role

    return Role.objects.create(
        server=server, name="Участник", is_default=True, position=0)
