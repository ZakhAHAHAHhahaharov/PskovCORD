"""Права ролей сервера — единственный источник правды о том, какие права
вообще бывают и как они складываются у конкретного участника.

Используется и REST-вьюхами (chat/views.py), и WS-консьюмером
(chat/consumers.py через database_sync_to_async), и сериализаторами — чтобы
список прав не расползался копиями по проекту. Соответствующие булевы поля
живут на chat.models.Role; при добавлении права правьте оба места.
"""

# (поле модели Role, человекочитаемое название, группа для UI редактора,
#  пояснение под названием — "" если название говорит само за себя)
#
# Порядок здесь — это порядок в редакторе ролей на клиенте (тот строит список
# из /api/permissions, см. web/src/components/ServerSettingsModal.tsx).
#
# Права, которые ещё не проверяются кодом, помечены в UPCOMING_PERMISSIONS и
# показываются в редакторе с пометкой «скоро» — раньше вместо этого их просто
# не показывали вовсе (см. историю manage_invites/manage_nicknames/
# mention_everyone), но тогда о будущих настройках никак не узнать. Пометка
# честнее: переключатель есть и сохраняется, но видно, что он пока ни на что
# не влияет.
PERMISSION_FIELDS = [
    ("view_channels", "Просматривать каналы", "general", ""),
    ("manage_channels", "Управлять каналами", "general", ""),
    ("manage_roles", "Управлять ролями", "general", ""),
    ("manage_server", "Управлять сервером", "general", ""),
    ("manage_members", "Выгонять / одобрять / банить участников", "general", ""),
    ("ban_members", "Банить участников",
     "general", "То же, что выше, но только бан — без кика и одобрения заявок."),
    ("create_invites", "Создание приглашений",
     "general", "Позволяет приглашать на этот сервер новых пользователей."),
    ("change_nickname", "Изменить никнейм",
     "general", "Позволяет менять свой никнейм, который используется только "
                "на этом сервере."),
    ("manage_nicknames", "Управлять никнеймами",
     "general", "Позволяет менять никнейм других пользователей."),

    ("create_expressions", "Создавать средства выражения эмоций",
     "expressions", "Позволяет добавлять пользовательские эмодзи, стикеры и звуки."),
    ("manage_expressions", "Управление выражениями",
     "expressions", "Позволяет редактировать и удалять пользовательские реакции."),

    ("send_messages", "Отправка сообщений", "text", ""),
    ("attach_files", "Прикреплять файлы",
     "text", "Позволяет прикреплять картинки, файлы и прочее к сообщениям."),
    ("add_reactions", "Добавлять реакции", "text", ""),
    ("use_external_emojis", "Использовать внешние эмодзи",
     "text", "Позволяет использовать эмодзи, созданные на других серверах."),
    ("use_external_stickers", "Использовать внешние стикеры",
     "text", "Позволяет использовать стикеры, созданные на других серверах."),
    ("mention_everyone", 'Упоминание "@all", "@here" и всех ролей',
     "text", "Позволяет упоминать всех участников сервера, только тех, кто в "
             "сети, и любые роли — даже те, у которых снято «разрешить всем "
             "упоминать эту роль»."),
    ("delete_messages", "Управление сообщениями",
     "text", "Позволяет удалять и откреплять сообщения других участников."),
    ("pin_messages", "Закреплять сообщения",
     "text", "Позволяет закреплять сообщения в канале."),
    ("bypass_slowmode", "Обход медленного режима",
     "text", "Если в текстовом канале включён медленный режим, участник с "
             "этим правом пишет без ожидания."),
    ("read_message_history", "Читать историю сообщений",
     "text", "Позволяет видеть сообщения, отправленные до текущего входа. "
             "Без этого права видны только те, что пришли, пока участник в сети."),

    ("connect", "Подключаться",
     "voice", "Позволяет заходить в голосовые каналы и слышать остальных."),
    ("speak", "Говорить", "voice", ""),
    ("video", "Видео",
     "voice", "Позволяет показывать демонстрацию экрана в голосовом канале."),
    ("start_mute_vote", "Начинать голосование за мут", "voice", ""),
    ("request_screen_share", "Просить демку",
     "voice", "Делает кнопку «Запросить демонстрацию» активной."),
]

# Группы для редактора ролей: (id из PERMISSION_FIELDS, заголовок секции).
# Порядок здесь задаёт порядок секций в UI.
PERMISSION_GROUPS = [
    ("general", "Общие права сервера"),
    ("expressions", "Средства выражения эмоций"),
    ("text", "Текстовые каналы"),
    ("voice", "Голосовые каналы"),
]

# Права, под которые ещё нет самой фичи. Переключатель в редакторе есть и
# сохраняется в БД, но кодом нигде не проверяется — в UI помечается «скоро»
# (см. PERMISSION_FIELDS выше). Как только фича появится — убрать отсюда.
UPCOMING_PERMISSIONS = {
    "create_expressions",
    "manage_expressions",
    "use_external_emojis",
    "use_external_stickers",
}

# Колонка manage_invites осталась от «управления приглашениями» — правом,
# которое так и не начали проверять; его место занял create_invites (создание
# ссылок), а удаление/отзыв чужих ссылок закрыт manage_members. Колонку не
# удаляем, чтобы не терять то, что могли настроить на живых серверах.
RESERVED_PERMISSION_FIELDS = [
    ("manage_invites", "Управлять приглашениями", "general"),
]

PERMISSION_NAMES = [field for field, _label, _group, _hint in PERMISSION_FIELDS]

# Права рядового участника — то, с чем создаётся роль по умолчанию (совпадает
# с дефолтами полей chat.models.Role) и то, что действует, если роли по
# умолчанию на сервере почему-то нет вообще (удалили через админку, сервер
# создан скриптом мимо API). Без этого запаса участники такого сервера
# молча теряли бы даже возможность писать.
BASE_MEMBER_PERMISSIONS = {
    "view_channels",
    "create_invites", "change_nickname",
    "send_messages", "attach_files", "add_reactions", "read_message_history",
    "use_external_emojis", "use_external_stickers",
    "connect", "speak", "video", "start_mute_vote", "request_screen_share",
}

# Права, которые нельзя снять с роли "Владелец" (см. models.Role.is_owner_role)
# даже через редактор — без них у никого на сервере не осталось бы способа
# вернуть их обратно (владелец всегда выше всех в иерархии, см.
# can_manage_role/highest_role_position — заступиться некому).
OWNER_LOCKED_PERMISSIONS = {"manage_server", "manage_roles"}


def all_permissions() -> dict:
    """Полный набор прав — то, что есть у владельца сервера."""
    return {name: True for name in PERMISSION_NAMES}


def no_permissions() -> dict:
    return {name: False for name in PERMISSION_NAMES}


def base_member_permissions() -> dict:
    return {name: name in BASE_MEMBER_PERMISSIONS for name in PERMISSION_NAMES}


def owner_permissions(server) -> dict:
    """Права владельца сервера. По умолчанию — все (см. all_permissions), но
    владелец может сознательно урезать себе часть через редактируемую роль
    "Владелец" (Role.is_owner_role, см. create_owner_role/ServerRoleDetail) —
    например, чтобы не мелькать в списке тех, кто может удалять чужие
    сообщения. OWNER_LOCKED_PERMISSIONS форсится в True независимо от того,
    что стоит на самой роли — без этого владелец мог бы случайно (или
    специально) заблокировать себе доступ к настройкам/ролям НАВСЕГДА: он
    всегда выше всех в иерархии (highest_role_position), заступиться некому.

    Сервер без own роли (ещё не создана — см. ServerRoles.get, лениво
    создаёт её при первом обращении к вкладке "Роли") — всё как раньше,
    полный набор прав."""
    from .models import Role

    owner_role = Role.objects.filter(server=server, is_owner_role=True).first()
    if owner_role is None:
        return all_permissions()
    result = {name: bool(getattr(owner_role, name, False)) for name in PERMISSION_NAMES}
    for name in OWNER_LOCKED_PERMISSIONS:
        result[name] = True
    return result


def permissions_for(user, server) -> dict:
    """Итоговые права участника на сервере: объединение (OR) прав роли по
    умолчанию и всех выданных ему ролей. Владелец сервера получает права по
    owner_permissions (по умолчанию — все, см. её докстринг).

    Не участник сервера прав не имеет вообще (даже прав роли по умолчанию).
    """
    from .models import Membership, Role

    if not user or not user.is_authenticated:
        return no_permissions()
    if server.owner_id == user.id:
        return owner_permissions(server)

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

    # Раньше владелец попадал сюда безусловно — но он мог сознательно снять
    # с себя это самое право через owner_permissions (см. её докстринг),
    # и тогда список "у кого есть право" продолжал бы врать, что оно есть.
    ids = [server.owner_id] if owner_permissions(server).get(permission) else []
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


def create_owner_role(server):
    """Роль «Владелец» — зеркало прав владельца сервера (см.
    owner_permissions), редактируемая только им самим (ServerRoleDetail.patch).
    Создаётся вместе с сервером; для серверов, заведённых до появления этой
    фичи, лениво досоздаётся при первом обращении к вкладке "Роли" (см.
    ServerRoles.get) — все PERMISSION_NAMES=True по умолчанию (all_permissions),
    то есть поведение таких серверов не меняется, пока владелец сам что-то
    не снимет."""
    from .models import Role

    return Role.objects.create(
        server=server, name="Владелец", color="#f0b232",
        is_owner_role=True, position=0, **all_permissions())
