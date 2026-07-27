"""Права ролей сервера — единственный источник правды о том, какие права
вообще бывают и как они складываются у конкретного участника.

Используется и REST-вьюхами (chat/views.py), и WS-консьюмером
(chat/consumers.py через database_sync_to_async), и сериализаторами — чтобы
список прав не расползался копиями по проекту. Соответствующие булевы поля
живут на chat.models.Role; при добавлении права правьте оба места.
"""

# (поле модели Role, человекочитаемое название, группа для UI редактора)
#
# Здесь только те права, которые РЕАЛЬНО проверяются кодом. Право, которого
# нет в этом списке, не попадает ни в API (RoleSerializer.Meta.fields), ни в
# редактор ролей — чтобы в UI не было переключателей, которые ничего не
# делают (именно так и появились manage_invites/manage_nicknames/
# mention_everyone, см. RESERVED_PERMISSION_FIELDS ниже).
PERMISSION_FIELDS = [
    ("view_channels", "Просматривать каналы", "general"),
    ("manage_channels", "Управлять каналами", "general"),
    ("manage_roles", "Управлять ролями", "general"),
    ("manage_server", "Управлять сервером", "general"),
    ("manage_members", "Выгонять/одобрять/банить участников", "general"),

    ("send_messages", "Отправка сообщений", "text"),
    ("delete_messages", "Удаление сообщений", "text"),

    ("speak", "Говорить", "voice"),
    ("video", "Показывать видео", "voice"),
]

# Колонки на chat.models.Role, которые остались от прав под ещё не
# существующие фичи: приглашений (модели Invite нет), никнеймов на сервере
# (поля nickname у Membership нет) и упоминаний @all/@online/@here (парсинга
# упоминаний нет ни на бэке, ни на фронте). Раньше они были в
# PERMISSION_FIELDS и выглядели в редакторе как рабочие настройки, хотя не
# проверялись нигде. Колонки не удаляем — вернём сюда, когда появятся сами
# фичи; до тех пор наружу их не показываем.
RESERVED_PERMISSION_FIELDS = [
    ("manage_invites", "Управлять приглашениями", "general"),
    ("manage_nicknames", "Управлять никнеймами", "general"),
    ("mention_everyone", "Упоминания @all / @online / @here", "text"),
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


# --- иерархия ролей ---------------------------------------------------------
# Без неё право manage_roles было эскалацией до владельца: участник с одним
# лишь «управлять ролями» мог завести роль с manage_server/manage_members и
# выдать её себе. Две независимые проверки закрывают это:
#   1) выдать можно только те права, которые есть у тебя самого
#      (missing_permissions_to_grant);
#   2) трогать можно только роли и участников строго НИЖЕ себя по позиции
#      (can_manage_role/can_act_on_member).
# Позиция — Role.position: больше значение = выше роль (Role.Meta.ordering
# сортирует по -position). Владелец сервера всегда выше любой роли.
OWNER_POSITION = float("inf")

# Участник вообще без персональных ролей. Ниже роли по умолчанию (position=0),
# поэтому такие участники не могут модерировать друг друга — как в Discord,
# где обладатели одного лишь @everyone равны между собой.
NO_ROLE_POSITION = -1.0


def _max_position(roles_iterable) -> float:
    positions = [float(r.position) for r in roles_iterable]
    return max(positions) if positions else NO_ROLE_POSITION


def highest_role_position(user, server) -> float:
    """Позиция самой высокой РОЛИ участника — его потолок в иерархии."""
    from .models import Membership

    if not user or not user.is_authenticated:
        return NO_ROLE_POSITION
    if server.owner_id == user.id:
        return OWNER_POSITION
    membership = Membership.objects.filter(
        user=user, server=server).prefetch_related("roles").first()
    if membership is None:
        return NO_ROLE_POSITION
    return _max_position(membership.roles.all())


def member_role_position(server, user_id) -> float:
    """То же самое для произвольного участника (цели модерации)."""
    from .models import Membership

    user_id = int(user_id)
    if server.owner_id == user_id:
        return OWNER_POSITION
    membership = Membership.objects.filter(
        server=server, user_id=user_id).prefetch_related("roles").first()
    if membership is None:
        return NO_ROLE_POSITION
    return _max_position(membership.roles.all())


def can_manage_role(user, server, role_position) -> bool:
    """Можно ли создать/изменить/удалить роль на такой позиции. Строго ниже
    собственной — иначе обладатель manage_roles правил бы роль администратора
    и свою собственную."""
    if server.owner_id == user.id:
        return True
    return float(role_position) < highest_role_position(user, server)


def missing_permissions_to_grant(user, server, wanted: dict) -> list:
    """Права из wanted, которых нет у самого user, — выдать их он не может."""
    if server.owner_id == user.id:
        return []
    mine = permissions_for(user, server)
    return [
        name for name in PERMISSION_NAMES
        if wanted.get(name) and not mine.get(name)
    ]


def member_ids_with_permission(server, permission: str) -> list:
    """id участников сервера, у которых есть право, — за два запроса вместо
    permissions_for() на каждого (тот делает свою пару запросов на участника).
    Нужно для адресных уведомлений модерации (см. chat.views)."""
    from .models import Membership, Role

    default_role = Role.objects.filter(server=server, is_default=True).first()
    if default_role is not None:
        default_grants = bool(getattr(default_role, permission, False))
    else:
        default_grants = permission in BASE_MEMBER_PERMISSIONS

    ids = [server.owner_id]
    for membership in Membership.objects.filter(
        server=server
    ).prefetch_related("roles"):
        if membership.user_id == server.owner_id:
            continue
        if default_grants or any(
            getattr(role, permission, False) for role in membership.roles.all()
        ):
            ids.append(membership.user_id)
    return ids


def can_act_on_member(actor, server, target_user_id) -> bool:
    """Может ли actor применить модерацию (кик/бан/выдача ролей/отключение от
    голоса) к участнику. Владельца не трогает никто; остальных — только тот,
    кто строго выше в иерархии."""
    target_user_id = int(target_user_id)
    if target_user_id == server.owner_id:
        return False
    if actor.id == server.owner_id:
        return True
    return member_role_position(server, target_user_id) < highest_role_position(
        actor, server)


def create_default_role(server):
    """Роль «Участник» — выдаётся при создании сервера, действует на всех.
    Дефолты полей Role уже описывают базового участника (читать каналы,
    писать, говорить, показывать видео), поэтому ничего не переопределяем."""
    from .models import Role

    return Role.objects.create(
        server=server, name="Участник", is_default=True, position=0)
