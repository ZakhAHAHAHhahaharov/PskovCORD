import secrets
import uuid

from django.conf import settings
from django.db import models
from django.db.models.signals import post_delete
from django.dispatch import receiver
from django.utils import timezone
from django.utils.text import get_valid_filename


class Server(models.Model):
    """Аналог Discord-сервера (гильдии)."""

    # Как попасть на сервер (вкладка «Доступ» редактора сервера).
    ACCESS_INVITE = "invite"
    ACCESS_REQUEST = "request"
    ACCESS_PUBLIC = "public"
    ACCESS_CHOICES = [
        (ACCESS_INVITE, "Только по приглашению"),
        (ACCESS_REQUEST, "По заявке"),
        (ACCESS_PUBLIC, "Публичный"),
    ]

    name = models.CharField(max_length=100)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_servers",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    # data-URL значка сервера (до 512x512, жмётся клиентом) — тот же приём
    # хранения, что и accounts.User.avatar_image: картинка маленькая, ради
    # неё не заводим MEDIA_ROOT. Пусто — в ServerRail рисуются инициалы.
    icon = models.TextField(blank=True, default="")
    # Баннер карточки сервера — ровно как баннер профиля (accounts.User):
    # либо строгий CSS-градиент, либо гифка/картинка data-URL (побеждает она).
    banner_gradient = models.CharField(max_length=120, blank=True, default="")
    banner_image = models.TextField(blank=True, default="")
    description = models.TextField(blank=True, default="")
    # «Особенности» сервера — короткие теги для поиска серверов и подсказки
    # при наведении. Список строк; JSONField, потому что это чистые данные
    # для отображения, отдельная таблица под них избыточна.
    tags = models.JSONField(default=list, blank=True)
    # Приватный сервер не отдаётся поиском серверов вообще — ни строкой, ни
    # именем (см. chat.views.ServerDiscover). Попасть в него можно, только
    # узнав о нём извне; на каких условиях пускают дальше, решает уже
    # access_mode — это ортогональные вещи (приватный + public = «не в
    # каталоге, но по ссылке заходи»).
    is_private = models.BooleanField(default=False)
    access_mode = models.CharField(
        max_length=10, choices=ACCESS_CHOICES, default=ACCESS_PUBLIC)
    age_restricted = models.BooleanField(default=False)
    # Правила сервера — список {"title": ..., "text": ...}, показывается
    # новичкам. Тоже JSONField по той же причине, что и tags.
    rules = models.JSONField(default=list, blank=True)

    def __str__(self) -> str:
        return self.name


class Role(models.Model):
    """Роль на сервере — набор прав, выдаваемый участникам (Membership.roles).

    Права хранятся отдельными булевыми полями, а не битовой маской: их
    немного, они редко меняются, а читаемость в админке/миграциях и
    возможность фильтровать запросом того стоят. Полный список полей (и их
    порядок/подписи в UI) — chat.roles.PERMISSION_FIELDS; при добавлении
    права правьте оба места. Дефолт поля обязан совпадать с тем, входит ли
    право в chat.roles.BASE_MEMBER_PERMISSIONS (см. PermissionCatalogTests) —
    иначе роль по умолчанию и «запасные» права разъедутся.
    """

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="roles")
    name = models.CharField(max_length=100)
    color = models.CharField(max_length=7, default="#99aab5")
    position = models.PositiveIntegerField(default=0)
    # Роль по умолчанию (аналог @everyone): её права действуют на всех
    # участников сервера, её нельзя удалить и не нужно никому выдавать.
    is_default = models.BooleanField(default=False)
    # Синтетическая роль-зеркало прав владельца сервера — см.
    # chat.roles.owner_permissions/create_owner_role. Не выдаётся никому (её
    # обладатель определяется полем Server.owner, а не Membership.roles),
    # редактировать её может только сам владелец (см. ServerRoleDetail.patch),
    # и manage_server/manage_roles на ней всегда форсятся в True на бэке
    # (chat.roles.OWNER_LOCKED_PERMISSIONS) — иначе владелец мог бы снять их
    # с себя и НАВСЕГДА потерять доступ к настройкам/ролям собственного
    # сервера (никто другой не выше него в иерархии, чтобы вернуть их).
    is_owner_role = models.BooleanField(default=False)

    # --- общие права сервера ---
    view_channels = models.BooleanField(default=True)
    manage_channels = models.BooleanField(default=False)
    manage_roles = models.BooleanField(default=False)
    manage_server = models.BooleanField(default=False)
    manage_invites = models.BooleanField(default=False)
    # Менять никнейм ДРУГИХ участников на этом сервере (Membership.nickname).
    manage_nicknames = models.BooleanField(default=False)
    # Менять СВОЙ никнейм на этом сервере.
    change_nickname = models.BooleanField(default=True)
    # Выгонять/одобрять заявки/банить/разбанить участников.
    manage_members = models.BooleanField(default=False)
    # Только банить — урезанная часть manage_members для роли «модератор»,
    # которой не положено ни кикать, ни одобрять заявки.
    ban_members = models.BooleanField(default=False)
    create_invites = models.BooleanField(default=True)

    # --- средства выражения эмоций (кастомные эмодзи/стикеры/звуки) ---------
    # Эмодзи (ServerEmoji) и стикеры (Sticker) уже настоящие, и права на них
    # общие: create_expressions пускает загружать новые, manage_expressions —
    # переименовывать и удалять чужие. Звуковой доски ещё нет.
    create_expressions = models.BooleanField(default=False)
    manage_expressions = models.BooleanField(default=False)

    # --- права текстового канала ---
    send_messages = models.BooleanField(default=True)
    attach_files = models.BooleanField(default=True)
    # Записывать и отправлять голосовые (Attachment.voice). Отдельно от
    # attach_files намеренно: «не засоряйте канал файлами» и «не наговаривайте
    # голосом вместо текста» — совершенно разные пожелания, и в каналах, где
    # запрещают второе, первое обычно как раз нужно.
    send_voice_messages = models.BooleanField(default=True)
    add_reactions = models.BooleanField(default=True)
    # Удалять/откреплять чужие сообщения («Управление сообщениями» в UI).
    delete_messages = models.BooleanField(default=False)
    pin_messages = models.BooleanField(default=False)
    # Читать сообщения, отправленные до текущего входа (см.
    # chat.presence.online_since и ChannelMessages).
    read_message_history = models.BooleanField(default=True)
    # Писать в канал с медленным режимом без ожидания (Channel.slowmode_seconds).
    bypass_slowmode = models.BooleanField(default=False)
    mention_everyone = models.BooleanField(default=False)
    # Ставить в каналах ЭТОГО сервера эмодзи ДРУГИХ серверов. Эмодзи самого
    # сервера доступны всем его участникам всегда и этим правом не режутся —
    # режется только «принёс со стороны» (см. chat.emoji.usable_ids).
    use_external_emojis = models.BooleanField(default=True)
    # То же самое для стикеров ДРУГИХ серверов. Отдельное право, а не общее с
    # эмодзи: стикер крупный и заметный, и «чужие эмодзи можно, чужие стикеры
    # нельзя» — вполне осмысленная настройка (см.
    # chat.emoji.usable_sticker_ids). Базовые наборы (StickerPack без сервера)
    # им не режутся — они ничьи.
    use_external_stickers = models.BooleanField(default=True)

    # --- права голосового канала ---
    # Подключаться к голосовому каналу и слышать остальных. Отдельно от speak:
    # connect=True/speak=False — «слушатель», который сидит в канале молча.
    connect = models.BooleanField(default=True)
    speak = models.BooleanField(default=True)
    video = models.BooleanField(default=True)
    start_mute_vote = models.BooleanField(default=True)
    request_screen_share = models.BooleanField(default=True)

    # --- кто может упоминать ЭТУ роль (@RoleName) ---------------------------
    # Не путать с manage_roles (управление ролью) — это про то, чьё сообщение
    # с "@ИмяРоли" в тексте вообще СЧИТАЕТСЯ пингом её участников, а не просто
    # текстом. Проверяется на клиенте при подсчёте непрочитанного/уведомлений
    # (см. web/src/mentions.ts) — сама отправка сообщения этим не режется:
    # "@ИмяРоли" от того, кому нельзя её пинговать, долетает как обычный
    # текст, просто не поднимает уведомление участникам роли.
    MENTION_EVERYONE = "everyone"
    MENTION_ROLES = "roles"
    MENTION_PERMISSION_CHOICES = [
        (MENTION_EVERYONE, "Все участники сервера"),
        (MENTION_ROLES, "Только выбранные роли"),
    ]
    mention_permission = models.CharField(
        max_length=10, choices=MENTION_PERMISSION_CHOICES, default=MENTION_EVERYONE)
    # Имеет смысл только при mention_permission=MENTION_ROLES — набор ролей,
    # УЧАСТНИКИ которых вправе пинговать эту роль. self-M2M несимметричный:
    # «роль A разрешает роли B пинговать себя» не означает обратного.
    mentionable_by = models.ManyToManyField(
        "self", blank=True, symmetrical=False, related_name="can_mention")

    class Meta:
        ordering = ["-position", "id"]

    def __str__(self) -> str:
        return f"{self.name} @ {self.server_id}"


class Membership(models.Model):
    NOTIFY_ALL = "all"
    NOTIFY_MENTIONS = "mentions"
    NOTIFY_NONE = "none"
    NOTIFY_CHOICES = [
        (NOTIFY_ALL, "Все сообщения"),
        (NOTIFY_MENTIONS, "Только упоминания"),
        (NOTIFY_NONE, "Ничего"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    server = models.ForeignKey(
        Server,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    # Роль по умолчанию (is_default) сюда не пишется — она и так действует
    # на всех участников, см. chat.roles.permissions_for.
    roles = models.ManyToManyField(Role, blank=True, related_name="members")
    # Никнейм НА ЭТОМ СЕРВЕРЕ — видят все участники сервера (в отличие от
    # приватного одностороннего FriendNickname, который видит только тот, кто
    # его поставил). Пусто — показывается обычное имя. Своё меняет право
    # change_nickname, чужие — manage_nicknames (см. chat.roles).
    nickname = models.CharField(max_length=100, blank=True, default="")

    # --- личные настройки уведомлений/приватности для ЭТОГО сервера --------
    # Ничего из этого не влияет на доставку сообщений (WS как и раньше шлёт
    # всё всем участникам группы сервера) — это чисто клиентский фильтр
    # "показывать ли непрочитанное/бейдж", см. AppShell.computeChannelNotice.
    notification_level = models.CharField(
        max_length=10, choices=NOTIFY_CHOICES, default=NOTIFY_ALL)
    # Заглушение на срок — muted_until в будущем; "навсегда" — отдельный флаг,
    # а не сигнальная дата (null=NaN-в-будущем неотличим от "забыли поставить").
    muted_until = models.DateTimeField(null=True, blank=True)
    muted_forever = models.BooleanField(default=False)
    # Не поднимать уведомление на буквальные "@all"/"@here" в сообщении.
    ignore_at_here = models.BooleanField(default=False)
    # Не поднимать уведомление на упоминание ролей, которые у меня есть —
    # личный отказ, независимый от Role.mention_permission (тот решает, чьё
    # "@ИмяРоли" вообще считается пингом; этот — хочу ли я его видеть).
    suppress_role_mentions = models.BooleanField(default=False)
    # Разрешить ЛС от других участников ЭТОГО сервера — работает как
    # дополнительное разрешение поверх accounts.User.dm_privacy, а не замена:
    # при dm_privacy=FRIENDS не-друг всё равно сможет написать, если делит с
    # адресатом сервер, где у адресата этот флаг включён (см. chat.permissions
    # .can_dm). При dm_privacy=NOBODY это исключение не действует — «никто»
    # значит никто, даже через сервер.
    allow_dms_from_server = models.BooleanField(default=True)
    # Закреплённые каналы ЭТОГО пользователя на сервере — правый клик по
    # голосовому каналу → "Закрепить вверху" (см. chat.roles/views —
    # порядок списка и есть порядок закрепления, новый пин встаёт первым;
    # см. web/src/components/ChannelSidebar.tsx сортировку). Чисто личная
    # раскладка, не влияет ни на кого другого — как заглушение/уведомления.
    pinned_channel_ids = models.JSONField(default=list, blank=True)

    # --- как участник сюда попал (блок «Способ вступления» в панели
    # модератора, см. chat.views.ServerMemberModeratorView) ----------------
    # Полем на Membership, а не выводом из ServerAuditLog: это свойство
    # ТЕКУЩЕГО членства, а не событие. Ушёл и вернулся по другой ссылке —
    # здесь должно стоять новое, а не первое за всю историю. Журнал же
    # хранит обе отлучки как отдельные записи, и одно другому не мешает.
    JOIN_UNKNOWN = "unknown"
    JOIN_PUBLIC = "public"
    JOIN_INVITE_LINK = "invite_link"
    JOIN_INVITE_DIRECT = "invite_direct"
    JOIN_REQUEST = "request"
    JOIN_OWNER = "owner"
    JOIN_METHOD_CHOICES = [
        (JOIN_UNKNOWN, "Неизвестно"),
        (JOIN_PUBLIC, "Открытый сервер"),
        (JOIN_INVITE_LINK, "Ссылка-приглашение"),
        (JOIN_INVITE_DIRECT, "Личное приглашение"),
        (JOIN_REQUEST, "Одобренная заявка"),
        (JOIN_OWNER, "Создатель сервера"),
    ]
    # unknown — не только «не знаем», но и все, кто вступил ДО появления
    # этих полей: заполнять их задним числом нечем, и врать точным способом
    # хуже, чем честно показать «Неизвестно».
    join_method = models.CharField(
        max_length=20, choices=JOIN_METHOD_CHOICES, default=JOIN_UNKNOWN)
    # Код ссылки, по которой вступили — только для JOIN_INVITE_LINK. Копия
    # строки, а не FK на ServerInvite: ссылку могут удалить, а «пришёл вот
    # по этой» должно остаться.
    join_invite_code = models.CharField(max_length=16, blank=True, default="")
    join_invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="invited_memberships")

    class Meta:
        unique_together = ("user", "server")

    def __str__(self) -> str:
        return f"{self.user} @ {self.server}"

    def is_muted(self, now=None) -> bool:
        if self.muted_forever:
            return True
        if self.muted_until is None:
            return False
        return self.muted_until > (now or timezone.now())


class ServerJoinRequest(models.Model):
    """Заявка на вступление — создаётся вместо мгновенного Membership, если
    сервер принимает по заявке (Server.ACCESS_REQUEST). Одобрение/отклонение —
    вкладка «Запросы» редактора сервера (нужно право manage_members)."""

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="join_requests")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="server_join_requests")
    message = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("server", "user")
        ordering = ["created_at", "id"]

    def __str__(self) -> str:
        return f"{self.user} -> {self.server}"


class ServerBan(models.Model):
    """Бан на сервере («ЧС списочек»). Пока строка есть — вступить нельзя,
    а участник при бане теряет Membership (см. chat.views.ServerMemberBan)."""

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="bans")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="server_bans")
    banned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="issued_server_bans")
    reason = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("server", "user")
        ordering = ["-created_at", "id"]

    def __str__(self) -> str:
        return f"{self.user} banned @ {self.server}"


class ServerAuditLog(models.Model):
    """Журнал событий по участникам сервера — то, что показывает блок
    «Журнал аудита» в панели модератора (см.
    chat.views.ServerMemberModeratorView).

    Пишется ТОЛЬКО о том, что нельзя восстановить из текущего состояния БД:
    кик/бан/разбан, выдача и снятие ролей, смена никнейма, вступление и
    выход. Счётчики сообщений/ссылок/медиа сюда НЕ пишутся — они считаются
    запросом по chat.models.Message в момент открытия панели (см. там же):
    так они верны и для истории, накопленной до появления журнала, а таблица
    не растёт на каждое сообщение в чате.

    Записи привязаны к паре (сервер, участник-цель) и переживают уход цели с
    сервера: модерации важно видеть историю того, кого уже выгнали. Оба
    пользователя — SET_NULL, чтобы удаление аккаунта не уносило с собой чужую
    историю модерации.
    """

    JOIN = "join"
    LEAVE = "leave"
    KICK = "kick"
    BAN = "ban"
    UNBAN = "unban"
    ROLE_ADD = "role_add"
    ROLE_REMOVE = "role_remove"
    NICKNAME = "nickname"
    ACTION_CHOICES = [
        (JOIN, "Вступление"),
        (LEAVE, "Выход"),
        (KICK, "Кик"),
        (BAN, "Бан"),
        (UNBAN, "Разбан"),
        (ROLE_ADD, "Выдана роль"),
        (ROLE_REMOVE, "Снята роль"),
        (NICKNAME, "Смена никнейма"),
    ]

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="audit_entries")
    # Кто ДЕЙСТВОВАЛ. Для JOIN/LEAVE совпадает с target (человек пришёл или
    # ушёл сам), для остального — модератор.
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="audit_actions")
    # О КОМ запись — по нему панель модератора и фильтрует.
    target = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="audit_records")
    action = models.CharField(max_length=20, choices=ACTION_CHOICES)
    # Подробности, своя форма у каждого действия: причина бана, имя и цвет
    # роли, старый/новый никнейм, способ вступления. JSON, а не колонки под
    # каждое — набор полей у восьми действий разный и будет меняться, а
    # читает их только фронт панели (см. web/src/components/ModeratorPanel).
    details = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            # Панель всегда спрашивает «записи про ЭТОГО человека на ЭТОМ
            # сервере, свежие сверху» — индекс ровно под этот запрос.
            models.Index(fields=["server", "target", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.action} {self.target_id} @ {self.server_id}"


def _invite_code() -> str:
    return secrets.token_urlsafe(6)


class ServerInvite(models.Model):
    """Приглашение на сервер — двух видов, отличаются семантикой погашения.

    DIRECT — адресное приглашение конкретному человеку (см.
    chat.views.ServerInvites): одна строка на пару (сервер, приглашённый),
    исчезает по принятию/отклонению — как ServerJoinRequest, только
    инициатор не владелец/модератор, а любой участник, и одобрения не
    требуется (сам факт приглашения от участника — уже разрешение).

    LINK — постоянная многоразовая ссылка сервера (chat.views.ServerInviteLink/
    ServerInviteRedeem): не привязана к конкретному человеку, строка не
    удаляется при использовании (иначе ссылка работала бы один раз).

    Оба вида бьют мимо Server.access_mode — обладание приглашением/ссылкой
    и есть авторизация, независимо от того, «только по приглашению» сервер,
    «по заявке» или публичный. Бан по-прежнему блокирует (см. вьюхи).
    """

    DIRECT = "direct"
    LINK = "link"
    KIND_CHOICES = [(DIRECT, "Личное приглашение"), (LINK, "Ссылка")]

    # Только для DIRECT — LINK всегда остаётся "pending" (у него нет
    # адресата, который мог бы принять/отклонить именно эту строку).
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    STATUS_CHOICES = [
        (PENDING, "Ожидает"), (ACCEPTED, "Принято"), (DECLINED, "Отклонено"),
    ]

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="invites")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="created_server_invites")
    kind = models.CharField(max_length=10, choices=KIND_CHOICES)
    # Только для DIRECT.
    invited_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True,
        blank=True, related_name="received_server_invites")
    # Только для LINK — короткий непредсказуемый токен в самой ссылке.
    code = models.CharField(max_length=16, blank=True, default="")
    # Приглашение зовёт не просто на сервер, а сразу в конкретный голосовой
    # канал (правый клик по каналу → "Пригласить в голосовой чат"/"Копировать
    # ссылку", см. chat.views.ChannelInviteLink/ChannelInvites). null — это
    # обычное серверное приглашение, как раньше.
    channel = models.ForeignKey(
        "Channel", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="invites")
    # DIRECT больше не удаляется по решению — приглашение живёт как карточка
    # в переписке (см. ConversationMessage.server_invite) и должно после
    # принятия/отклонения продолжать показывать своё состояние там.
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default=PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    # Только для LINK — сколько раз по ЭТОЙ ссылке реально вступили (см.
    # chat.views.ServerInviteRedeem). У DIRECT не растёт — там и так ровно
    # один адресат, статус accepted/declined говорит то же самое. Нужен,
    # чтобы у каждого участника была СВОЯ ссылка (см. created_by в lookup'е
    # ServerInviteLink.get) и было видно, сколько народу привёл именно он —
    # себе самому в ServerInviteModal и модераторам в ServerSettingsModal
    # (см. ServerInviteLinksList, требует manage_members).
    uses = models.PositiveIntegerField(default=0, verbose_name="Использований")

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            # Не больше одного АКТИВНОГО (pending) личного приглашения от
            # сервера этому человеку разом — иначе повторные "Пригласить"
            # плодили бы дубли. Решённые (accepted/declined) остаются в
            # истории и не мешают пригласить снова. Только для ОБЩИХ
            # (channel=null) приглашений — приглашение в конкретный канал
            # ниже своя отдельная пара, чтобы оба вида могли сосуществовать
            # (позвал на сервер вообще, потом отдельно — в конкретный канал).
            models.UniqueConstraint(
                fields=["server", "invited_user"],
                condition=models.Q(kind="direct", status="pending", channel__isnull=True),
                name="unique_direct_server_invite",
            ),
            models.UniqueConstraint(
                fields=["server", "invited_user", "channel"],
                condition=models.Q(kind="direct", status="pending", channel__isnull=False),
                name="unique_direct_channel_invite",
            ),
            # Код ссылки уникален глобально (это и есть весь секрет ссылки).
            models.UniqueConstraint(
                fields=["code"],
                condition=models.Q(kind="link"),
                name="unique_server_invite_link_code",
            ),
        ]

    def __str__(self) -> str:
        if self.kind == self.LINK:
            return f"link:{self.code} -> {self.server}"
        return f"{self.invited_user} -> {self.server}"


class Channel(models.Model):
    TEXT = "text"
    VOICE = "voice"
    # Ветка (в Discord — «thread») — это тоже канал, а не отдельная модель:
    # у неё те же сообщения, вложения, реакции, закрепления, курсор прочтения
    # и личные настройки уведомлений, что и у обычного текстового канала.
    # Заводить под всё это параллельный набор моделей значило бы дублировать
    # половину приложения ради одного отличия — наличия родителя (см. parent).
    THREAD = "thread"
    KIND_CHOICES = [(TEXT, "Text"), (VOICE, "Voice"), (THREAD, "Thread")]
    # Виды, в которых можно писать сообщения. Голосовой канал сюда тоже
    # входит: у него есть встроенный текстовый чат (как в Discord) — те же
    # Message с channel=<голосовой канал>, просто показанные не отдельной
    # страницей, а панелью рядом со «сценой» звонка (см. web AppShellChat).
    WRITABLE_KINDS = (TEXT, VOICE, THREAD)

    server = models.ForeignKey(
        Server,
        on_delete=models.CASCADE,
        related_name="channels",
    )
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, default=TEXT)
    position = models.PositiveIntegerField(default=0)
    # Персистентный статус канала (правый клик → "Установить статус канала",
    # см. chat.views.ChannelDetail) — НЕ то же самое, что эфемерная тема
    # звонка (presence.call_topic/voice_topic_update): та живёт только пока
    # в голосовом канале кто-то есть и стирается вместе с последним ушедшим,
    # этот виден всегда, пока его явно не поменяют/не очистят.
    #
    # То же самое поле служит и «темой канала» для ТЕКСТОВЫХ каналов (правый
    # клик → «Настроить канал» → Обзор) — заводить для этого отдельное поле
    # незачем: разница только в том, для канала какого вида его показывают
    # (см. ChannelContextMenu/ChannelSettingsModal), а хранится и валидируется
    # оно одинаково для обоих. 1024 — предел темы (как у Discord), голосовому
    # статусу столько не нужно, но и не мешает.
    status = models.CharField(max_length=1024, blank=True, default="")
    # Медленный режим: сколько секунд автор обязан ждать между своими
    # сообщениями в этом канале. 0 — выключен. Обходится правом
    # bypass_slowmode (см. chat.roles) — проверка живёт в
    # GatewayConsumer._create_message, где и создаётся сообщение.
    slowmode_seconds = models.PositiveIntegerField(default=0)
    # Видимость контента (Обзор в ChannelSettingsModal) — три взаимоисключающих
    # варианта в виде двух независимых флагов, а не одного choice-поля: оба
    # уже были самостоятельными булевыми полями (is_spoiler завели раньше
    # age_restricted), и сводить их в общий enum значило бы переносить данные
    # ради формы, а не смысла. Взаимную исключаемость обеспечивает фронт —
    # там это один radio-выбор (см. ChannelSettingsModal onSetVisibility).
    #
    # is_spoiler — вход в канал на фронте сначала показывает предупреждение о
    # чувствительном контенте — чисто клиентский гейт, бэкенду достаточно
    # знать сам флаг.
    is_spoiler = models.BooleanField(default=False)
    # age_restricted — пока тоже только флаг без применения (само ограничение
    # доступа по возрасту — отдельная задача, флаг заводится заранее, чтобы
    # его уже можно было выставлять и видеть).
    age_restricted = models.BooleanField(default=False)

    # Приватный канал: виден только тем, у кого есть manage_channels, и
    # обладателям ролей из allowed_roles ЛИБО явно перечисленным в
    # allowed_users. Обычное право view_channels на него не распространяется —
    # в этом и смысл: «видеть каналы» даёт публичные, а к приватному нужен
    # явный допуск (см. chat.permissions.can_see_channel).
    is_private = models.BooleanField(default=False)
    # Роли, которым открыт приватный канал. Пусто — канал виден только
    # управляющим каналами (роль «staff-only»), это осмысленное состояние по
    # умолчанию сразу после создания, а не полуфабрикат.
    allowed_roles = models.ManyToManyField(
        Role, blank=True, related_name="allowed_channels")
    # Персонально допущенные участники — вдобавок к тем, кто попадает через
    # allowed_roles. Нужны отдельно: вкладка «Права доступа» показывает «кто
    # сейчас видит канал» и даёт СНЯТЬ доступ конкретному человеку — а снять
    # роль у него на этом основании было бы не тем действием (роль может
    # открывать ему и другие каналы). Из allowed_users убрать можно только
    # того, кто в нём и лежит — доступ через роль отсюда не отнять, только
    # через саму роль (см. ChannelSettingsModal, там же и обе причины
    # видны рядом).
    allowed_users = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="allowed_private_channels")
    # «Приостановить приглашения» (вкладка «Приглашения»): временно не даёт
    # заводить НОВЫЕ приглашения именно В ЭТОТ канал (chat.views.ServerInvites/
    # ServerInviteLink) — уже разосланные и решения по ним не затрагивает.
    invites_paused = models.BooleanField(default=False)

    # --- только для kind=THREAD ---------------------------------------------
    # Канал, внутри которого живёт ветка. У обычных каналов пусто. Вложенность
    # ровно одна: ветка в ветке запрещена в ручке (см. chat.views.ChannelThreads),
    # и на это опирается chat.permissions.can_see_channel — там разбор родителя
    # не рекурсивный, а в один шаг.
    #
    # CASCADE: удалили канал — уносим и его ветки. Они не могут пережить
    # родителя, от которого берут и права доступа, и само место в списке.
    parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="threads",
    )
    # Сообщение, из которого ветку создали (правый клик → «Создать ветку»).
    # Пусто у веток, заведённых кнопкой в самом канале, — это законное
    # состояние, а не полуфабрикат. Нужно ради плашки «Ветка: имя» под самим
    # сообщением (её рисует фронт по этому полю, см. web MessageList) —
    # поэтому SET_NULL, а не CASCADE: удаление исходного сообщения не должно
    # уносить с собой обсуждение, которое из него выросло, пропадает только
    # сама плашка.
    source_message = models.ForeignKey(
        "Message",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="threads",
    )
    # Архивная ветка не показывается в списке каналов сервера (см.
    # ServerSerializer.get_channels) — обсуждение закончилось. Не удаление:
    # сообщения остаются на месте, ветку можно вернуть (кнопка в её шапке,
    # см. chat.views.ThreadArchive) — и она возвращается сама, если кто-то
    # в неё написал (см. chat.consumers._create_message).
    archived = models.BooleanField(default=False)
    # Кто завёл ветку — ему можно её архивировать без права manage_channels
    # (своё обсуждение закрывает автор, см. ThreadArchive). SET_NULL: удаление
    # аккаунта не повод уносить ветку, просто «автор неизвестен».
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_threads",
    )
    # Приватная ветка — видна только тем, кого в неё позвали (ThreadMember), и
    # управляющим каналами. Это НЕ то же самое, что is_private у канала: та
    # приватность решается ролями и списком допущенных, а здесь допуск ровно
    # один — участие в самой ветке. Отдельным полем, а не переиспользованием
    # is_private, потому что is_private у ветки занят под другое: он копируется
    # с родителя и служит только адресной рассылке событий (см.
    # chat.views.ChannelThreads).
    #
    # Приватность ветки НЕ отменяет приватности канала: ветка сперва должна
    # быть видна по родителю, и только потом проверяется эта (см.
    # chat.permissions.can_see_channel).
    invite_only = models.BooleanField(default=False)
    # Заблокированная ветка: читать можно, писать — только тем, кто
    # распоряжается сообщениями. В отличие от archived, сама собой не
    # снимается: закрытая ветка оживает от нового сообщения, а
    # заблокированная на то и заблокирована, чтобы этого не произошло.
    locked = models.BooleanField(default=False)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:
        return f"{self.server.name}#{self.name}"


class ThreadMember(models.Model):
    """Кто участвует в ветке.

    Участие решает две вещи. Первая — что показывать в сайдбаре: там висят
    только СВОИ ветки, как в Discord, а остальные достаются из списка «Все
    ветки» (см. chat.views.ChannelThreadList). Без этого сайдбар канала с
    десятком обсуждений превращался бы в стену, где своё не найти.

    Вторая — доступ к приватной ветке (Channel.invite_only): туда пускают
    поимённо, и эта же строка и есть пропуск.

    Заводится сама: автор ветки участвует в ней с момента создания, остальные
    присоединяются, написав в неё (см. chat.consumers._create_message) — или
    явно, кнопкой «Присоединиться к ветке». Уйти можно тоже явно, и тогда
    строка удаляется: «не участвую» — это её отсутствие, а не флаг, ровно как
    у ChannelMemberSettings «стандартные настройки».
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="thread_memberships")
    thread = models.ForeignKey(
        Channel, on_delete=models.CASCADE, related_name="thread_members")
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "thread"], name="unique_thread_member"),
        ]

    def __str__(self) -> str:
        return f"{self.user} in {self.thread}"


class ChannelMemberSettings(models.Model):
    """Личные настройки уведомлений и заглушения ОДНОГО канала — тот же
    смысл, что у Membership для сервера целиком (см. её докстринг про
    notification_level/muted_*), только per-канал и с добавочным вариантом
    NOTIFY_DEFAULT «как на сервере»: этими настройками можно НЕ переопределять
    ничего, оставив решение серверному Membership.notification_level — именно
    поэтому default тут не совпадает по смыслу ни с одним из серверных.

    Строка заводится только когда участник явно что-то поменял для этого
    канала (см. chat.views.ChannelMemberSettingsView) — «стандартные
    настройки» сама по себе строки не требует, это и есть её отсутствие.
    """

    NOTIFY_DEFAULT = "default"
    NOTIFY_ALL = "all"
    NOTIFY_MENTIONS = "mentions"
    NOTIFY_NONE = "none"
    NOTIFY_CHOICES = [
        (NOTIFY_DEFAULT, "Как на сервере"),
        (NOTIFY_ALL, "Все сообщения"),
        (NOTIFY_MENTIONS, "Только упоминания"),
        (NOTIFY_NONE, "Ничего"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="channel_settings")
    channel = models.ForeignKey(
        Channel, on_delete=models.CASCADE, related_name="member_settings")
    notification_level = models.CharField(
        max_length=10, choices=NOTIFY_CHOICES, default=NOTIFY_DEFAULT)
    # То же устройство заглушения, что у Membership: срок — muted_until в
    # будущем, «пока не включу» — отдельный флаг muted_forever, а не
    # сигнальная дата.
    muted_until = models.DateTimeField(null=True, blank=True)
    muted_forever = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "channel"], name="unique_channel_member_settings"),
        ]

    def __str__(self) -> str:
        return f"{self.user} @ {self.channel}"

    def is_muted(self, now=None) -> bool:
        if self.muted_forever:
            return True
        if self.muted_until is None:
            return False
        return self.muted_until > (now or timezone.now())


class Message(models.Model):
    channel = models.ForeignKey(
        Channel,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    # Пусто разрешено с появлением вложений: сообщение из одной картинки без
    # подписи — совершенно нормальное. Проверку «хоть что-то одно должно быть»
    # делает отправляющий код (chat.consumers._handle_send), а не БД: пустое
    # сообщение без вложений законно существует ровно один миг между
    # Message.objects.create() и привязкой Attachment'ов в той же транзакции.
    content = models.TextField(blank=True, default="")
    reply_to = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="replies",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    # Закреплено в канале (см. chat.consumers._handle_pin_message). Хранится
    # МОМЕНТ закрепления, а не просто флаг: список закреплённых сортируется
    # именно по нему — «последнее закреплённое сверху», как в Discord, а не
    # по дате написания самого сообщения.
    pinned_at = models.DateTimeField(null=True, blank=True)

    # --- системные сообщения -------------------------------------------------
    # Пусто — обычное сообщение, написанное человеком; так у подавляющего
    # большинства строк, поэтому дефолт именно такой. Непустое — служебная
    # запись, которую никто не писал: её текст собирает клиент из полей
    # (см. web MessageList), а не берёт из content — иначе он был бы намертво
    # прибит к языку, на котором его сочинили в момент создания.
    #
    # Отдельным полем на Message, а не отдельной моделью: системная запись
    # стоит в ленте наравне с обычными, участвует в той же пагинации и в том
    # же курсоре прочтения — держать её в стороне значило бы сливать два
    # источника при каждой выдаче истории.
    SYSTEM_THREAD_CREATED = "thread_created"
    SYSTEM_KIND_CHOICES = [(SYSTEM_THREAD_CREATED, "Создана ветка")]
    system_kind = models.CharField(
        max_length=20, blank=True, default="", choices=SYSTEM_KIND_CHOICES)
    # Ветка, о которой сообщает системная запись (у SYSTEM_THREAD_CREATED).
    # CASCADE: удалили ветку — запись «создана ветка» ссылаться больше не на
    # что и смысла не имеет, в отличие от source_message у самой ветки (там
    # SET_NULL: обсуждение переживает своё исходное сообщение).
    system_thread = models.ForeignKey(
        Channel,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="creation_notices",
    )

    class Meta:
        ordering = ["created_at", "id"]

    @property
    def pinned(self) -> bool:
        return self.pinned_at is not None

    def __str__(self) -> str:
        return f"{self.author}: {self.content[:30]}"


class ChannelReadState(models.Model):
    """До какого сообщения участник дочитал этот текстовый канал.

    Курсор — «открыть канал там, где остановился» (см. chat.views
    ChannelReadStateView): при заходе в канал клиент сравнивает
    last_read_message_id с самым свежим сообщением и либо прокручивает в
    самый низ (всё видено), либо догружает и показывает то, что пропущено.

    last_read_message_id хранится КАК ЕСТЬ, без FK на Message: сообщение,
    на которое он указывает, к этому моменту могло быть удалено, а курсор
    должен пережить удаление ровно как переживают его id в токенах реакций и
    эмодзи (см. chat.emoji) — сравнения "message.id > last_read_message_id"
    работают одинаково, есть объект за этим id или нет.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="channel_read_states")
    channel = models.ForeignKey(
        Channel, on_delete=models.CASCADE, related_name="read_states")
    last_read_message_id = models.BigIntegerField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "channel"], name="unique_channel_read_state"),
        ]

    def __str__(self) -> str:
        return f"{self.user} @ {self.channel}: {self.last_read_message_id}"


_DM_ROOM_PREFIX = "dm_"


def dm_room(conversation_id) -> str:
    """Синтетический room-id для chat.presence/sfu.access_token — оба
    работают с channel_id как с непрозрачной строкой (просто ключ Redis /
    поле в JWT), так что звонки в личке/группе переиспользуют их без
    единой правки, просто передавая эту строку вместо настоящего Channel.id."""
    return f"{_DM_ROOM_PREFIX}{conversation_id}"


def is_dm_room(room) -> bool:
    """Отличает комнату диалога/группы от настоящего Channel.id в местах,
    где presence отдаёт «текущую комнату» юзера безлично (просто строку) —
    см. GatewayConsumer._handle_voice_leave/_mute_update/_screen_share_update."""
    return isinstance(room, str) and room.startswith(_DM_ROOM_PREFIX)


def dm_conversation_id(room: str) -> int:
    return int(room[len(_DM_ROOM_PREFIX):])


class Conversation(models.Model):
    """Личка (dm, ровно 2 участника) или групповой чат (group, 2+) — вне
    серверов/каналов. Голос переиспользует chat.presence как есть: комнатой
    для presence/SFU служит синтетический room=f"dm_{conversation.id}" (см.
    chat.consumers._dm_room), а не отдельная модель — presence.py работает
    с channel_id как с непрозрачной строкой, ему всё равно."""

    DM = "dm"
    GROUP = "group"
    KIND_CHOICES = [(DM, "Личное сообщение"), (GROUP, "Группа")]

    kind = models.CharField(max_length=10, choices=KIND_CHOICES)
    # Только для group; опционально — пусто показывается как список имён
    # участников на фронте (как безымянная групповая ЛС в Discord).
    name = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    participants = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through="ConversationParticipant",
        related_name="conversations",
    )
    # Канонический ключ пары для kind=dm: "<меньший id>:<больший id>".
    # Уникальный индекс по нему — единственный надёжный способ не получить два
    # параллельных диалога между одной и той же парой: «проверить, что диалога
    # нет, и создать» — это гонка (двойной клик, две вкладки), которую нельзя
    # закрыть на уровне приложения. Пусто у групп и у дублей, доставшихся из
    # истории (см. миграцию 0006) — их индекс не трогает.
    dm_key = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["dm_key"],
                condition=models.Q(kind="dm") & ~models.Q(dm_key=""),
                name="unique_dm_conversation_pair",
            )
        ]

    @staticmethod
    def build_dm_key(user_a_id, user_b_id) -> str:
        low, high = sorted((int(user_a_id), int(user_b_id)))
        return f"{low}:{high}"

    def __str__(self) -> str:
        return self.name or f"conversation#{self.id}"


class ConversationParticipant(models.Model):
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="conversation_memberships")
    joined_at = models.DateTimeField(auto_now_add=True)
    # Закреплён вверху списка «Диалоги» — личное предпочтение, поэтому лежит
    # на участии, а не на самой беседе: закрепивший видит её первой, у
    # собеседника порядок свой.
    pinned = models.BooleanField(default=False)
    # «Закрыть ЛС» — беседа пропадает из списка, но НЕ удаляется: история
    # цела, участие тоже (в отличие от выхода из группы, см.
    # chat.views.ConversationDetail.delete). Возвращается сама, когда придёт
    # новое сообщение (см. chat.consumers._reopen_for_recipients) — ровно как
    # в Discord: закрыл переписку, человек написал — она снова на месте.
    closed = models.BooleanField(default=False)

    class Meta:
        unique_together = ("conversation", "user")

    def __str__(self) -> str:
        return f"{self.user} in {self.conversation}"


class UserRelationState(models.Model):
    """Личное отношение ОДНОГО пользователя к другому: игнор и блокировка.

    Одна строка на упорядоченную пару (user → target), оба флага в ней же:
    смыслы разные, но живут вместе, потому что спрашивают их всегда вместе
    (один запрос на отрисовку меню, один — на фильтрацию ленты).

    ignored — «не беспокоить»: сообщения видны как обычно, но уведомления и
      звук по ним не поднимаются (см. фронт useGatewayEvents).
    blocked — сообщения target'а скрываются из серверных чатов и лички у
      того, кто заблокировал (см. chat.views._visible_messages), и target
      больше не может начать с ним личку (см. chat.permissions.can_dm).
      Односторонне и невзаимно: заблокированный об этом не уведомляется и
      продолжает видеть чужие сообщения у себя — как в Discord.

    Только для «мягких» личных настроек. Бан на сервере — совсем другое
    (ServerBan): тот действует на всех и выкидывает с сервера.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="relation_states")
    target = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="relation_states_about")
    ignored = models.BooleanField(default=False)
    blocked = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("user", "target")

    def __str__(self) -> str:
        flags = ", ".join(
            [f for f, on in (("ignored", self.ignored), ("blocked", self.blocked)) if on]
        ) or "none"
        return f"{self.user_id} → {self.target_id}: {flags}"


class ConversationMessage(models.Model):
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="messages")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="conversation_messages")
    # Пусто разрешено — см. Message.content.
    content = models.TextField(blank=True, default="")
    reply_to = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="replies")
    # Личное приглашение на сервер, пришедшее КАРТОЧКОЙ прямо в переписку с
    # пригласившим — вместо отдельной вкладки "Приглашения" (см.
    # chat.views._send_invite_message). SET_NULL, а не CASCADE: удаление
    # ServerInvite не должно рвать историю сообщений — такое приглашение
    # само никогда не удаляется (см. ServerInvite.status), но на будущее
    # это безопаснее, чем каскадом стирать чужую переписку.
    server_invite = models.ForeignKey(
        "ServerInvite", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="conversation_messages")
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self) -> str:
        return f"{self.author}: {self.content[:30]}"


# --- вложения и реакции -----------------------------------------------------
# Оба вида сообщений (Message в канале сервера и ConversationMessage в личке/
# группе) — разные таблицы с разными правилами доступа, но вложения и реакции
# у них устроены одинаково. Вместо двух пар почти одинаковых моделей (или
# GenericForeignKey, который лишает нас внешних ключей и каскадного удаления)
# здесь одна модель с ДВУМЯ nullable-FK и check-constraint'ом «заполнен ровно
# один из них». Так остаётся и целостность на уровне БД, и ON DELETE CASCADE:
# удалили сообщение — уехали и его вложения с реакциями.

ATTACHMENT_SUBDIR = "attachments"

# Потолок на один файл. Не техническое ограничение, а защита диска и чужого
# трафика: файлы отдаёт nginx напрямую из volume'а, никакой квоты сверху нет.
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
# Сколько файлов можно повесить на одно сообщение — как в Discord.
MAX_ATTACHMENTS_PER_MESSAGE = 10

# --- голосовые сообщения ---
# Потолок длительности. Не про диск (его стережёт MAX_ATTACHMENT_BYTES, и 10
# минут opus'а в него укладываются с запасом), а про жанр: голосовое — это
# реплика вместо печати, а не подкаст, который никто не станет слушать.
MAX_VOICE_MS = 10 * 60 * 1000
# Сколько столбиков в дорожке. 64 — ровно столько, чтобы рисунок читался и на
# узком мобильном пузыре; больше значило бы гонять в каждом сообщении массив,
# который всё равно негде показать.
MAX_WAVEFORM_POINTS = 64
# Сколько РАЗНЫХ эмодзи может висеть на одном сообщении. Ограничение на
# сообщение, а не на пользователя: один человек волен поставить все 20 сразу.
MAX_REACTIONS_PER_MESSAGE = 20
# Длины хватает и на unicode-последовательность с ZWJ и модификаторами тона
# (семья из четырёх человек — это 11 кодовых точек), и на будущий ключ
# кастомного эмодзи сервера вида "custom:<id>" (см. web/src/emoji.ts).
MAX_EMOJI_LEN = 64


def attachment_upload_to(instance, filename: str) -> str:
    """MEDIA_ROOT/attachments/<uuid>/<исходное имя>.

    Каталог на файл, а не общая свалка: имя внутри остаётся человеческим (оно
    же уезжает в Content-Disposition при скачивании), но коллизий не бывает —
    два `photo.jpg` от разных людей лежат в разных uuid-каталогах.

    uuid здесь заодно единственная защита самого файла: /media/ отдаёт nginx
    напрямую, без похода в Django, то есть без проверки прав (см.
    deploy/nginx.conf.example). Ссылка неугадываема, но тот, кому она попала,
    файл получит — ровно та же модель, что у вложений в Discord. Если однажды
    понадобится настоящая проверка доступа, менять придётся не модель, а
    раздачу: отдавать через вьюху с X-Accel-Redirect.
    """
    safe = get_valid_filename(filename) or "file"
    return f"{ATTACHMENT_SUBDIR}/{instance.id.hex}/{safe[:100]}"


class Attachment(models.Model):
    """Файл, прикреплённый к сообщению.

    Живёт двумя стадиями. Сначала загружается сам по себе (POST
    /api/attachments) и висит «ничей» — с uploaded_by, но без обоих FK на
    сообщения; так композер на фронте показывает превью и прогресс до того,
    как сообщение вообще отправлено, а сама отправка по WS остаётся лёгким
    JSON'ом со списком id. Потом send_message привязывает его к созданному
    сообщению (см. chat.consumers._bind_attachments).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="uploaded_attachments")
    file = models.FileField(upload_to=attachment_upload_to, max_length=300)
    # Имя, которое видел пользователь у себя на диске: file.name уже
    # просанитизировано под файловую систему (get_valid_filename), а показывать
    # и отдавать при скачивании нужно исходное.
    original_name = models.CharField(max_length=255)
    # Тип берём НЕ из заголовка запроса (клиент шлёт что хочет), а определяем
    # на сервере по содержимому — см. chat.views.AttachmentUpload.
    content_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    # Только у картинок — фронту нужны, чтобы зарезервировать место под превью
    # до его загрузки и не дёргать вёрстку уже прочитанного чата.
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    # Голосовое сообщение — записанное прямо в клиенте, а не выбранное файлом.
    # Отдельный флаг, а не «догадка по content_type»: обычный присланный mp3 —
    # это вложение, которое открывают плеером, а голосовое рисуется дорожкой во
    # всю ширину сообщения и режется собственным правом (send_voice_messages).
    voice = models.BooleanField(default=False)
    # Длительность в миллисекундах — чтобы показать «00:41» ДО того, как
    # браузер скачает и распарсит сам файл (у webm из MediaRecorder
    # длительность в контейнере вообще часто не проставлена, и <audio>
    # сообщает Infinity, пока не доиграет до конца).
    duration_ms = models.PositiveIntegerField(null=True, blank=True)
    # Пики громкости 0..100 — та самая «дорожка» столбиками. Считает клиент при
    # записи (см. web/src/voiceRecorder.ts): у бэкенда нет декодера звука, а
    # у браузера он встроенный.
    waveform = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    message = models.ForeignKey(
        Message, null=True, blank=True, on_delete=models.CASCADE,
        related_name="attachments")
    conversation_message = models.ForeignKey(
        ConversationMessage, null=True, blank=True, on_delete=models.CASCADE,
        related_name="attachments")

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.CheckConstraint(
                # Ровно один владелец либо ни одного (свежая загрузка).
                check=models.Q(message__isnull=True)
                | models.Q(conversation_message__isnull=True),
                name="attachment_single_owner",
            )
        ]

    def __str__(self) -> str:
        return f"{self.original_name} ({self.size} B)"


@receiver(post_delete, sender=Attachment)
def _cleanup_attachment_file(sender, instance, **kwargs):
    """Сигнал, а не override delete(): каскадное удаление вложений вместе с
    сообщением идёт через queryset, и override метода модели его бы не увидел —
    строки бы исчезли, а файлы остались лежать на диске навсегда.

    save=False — модели, которую удаляют, повторный save() не нужен и был бы
    ошибкой (строки уже нет).
    """
    if instance.file:
        instance.file.delete(save=False)


class Reaction(models.Model):
    """Реакция-эмодзи одного человека на одно сообщение.

    Одна строка = один (пользователь, сообщение, эмодзи). Счётчики, которые
    видит фронт, считаются агрегатом при сериализации (см.
    chat.serializers.reactions_map) — отдельное поле-счётчик означало бы два
    источника правды и неизбежный рассинхрон.
    """

    emoji = models.CharField(max_length=MAX_EMOJI_LEN)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="reactions")
    created_at = models.DateTimeField(auto_now_add=True)

    message = models.ForeignKey(
        Message, null=True, blank=True, on_delete=models.CASCADE,
        related_name="reactions")
    conversation_message = models.ForeignKey(
        ConversationMessage, null=True, blank=True, on_delete=models.CASCADE,
        related_name="reactions")

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            # Дважды одну и ту же реакцию один человек поставить не может —
            # гарантия на уровне БД, а не только проверкой в консьюмере: два
            # клика подряд из двух вкладок это классическая гонка.
            models.UniqueConstraint(
                fields=["message", "user", "emoji"],
                condition=models.Q(message__isnull=False),
                name="unique_message_reaction",
            ),
            models.UniqueConstraint(
                fields=["conversation_message", "user", "emoji"],
                condition=models.Q(conversation_message__isnull=False),
                name="unique_conversation_message_reaction",
            ),
            models.CheckConstraint(
                # У реакции владелец обязателен (в отличие от Attachment,
                # который какое-то время живёт ничей) — ровно один из двух.
                check=(
                    models.Q(message__isnull=False,
                             conversation_message__isnull=True)
                    | models.Q(message__isnull=True,
                               conversation_message__isnull=False)
                ),
                name="reaction_exactly_one_owner",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} {self.emoji}"


EMOJI_SUBDIR = "emoji"

# Потолок на один кастомный эмодзи. Жёстче вложений на два порядка и по другой
# причине: эмодзи не открывают по клику, его рисуют ДЕСЯТКАМИ разом — в ленте
# реакций, в сетке пикера, в каждом сообщении. Мегабайтная гифка, размноженная
# по экрану, кладёт не диск, а сам клиент.
MAX_EMOJI_BYTES = 256 * 1024
# Сколько эмодзи влезает на один сервер. Ограничение живёт здесь, а не в
# настройках: это защита от того, чтобы ответ /api/emoji (он грузится целиком
# при старте клиента) не рос без предела.
MAX_EMOJI_PER_SERVER = 250
# Имя эмодзи — то, что стоит между двоеточиями в токене <:name:id> (см.
# chat.emoji). Латиница/цифры/подчёркивание, как в Discord: имя попадает в
# текст сообщения, и разбирать его регуляркой проще, когда алфавит узкий.
MAX_EMOJI_NAME_LEN = 32
MIN_EMOJI_NAME_LEN = 2

# Расширения, которые вообще могут получиться у файла эмодзи, — по одному на
# формат из chat.uploads.EMOJI_IMAGE_FORMATS. Список нужен именно здесь: см.
# emoji_upload_to, почему расширение решает вопрос безопасности.
EMOJI_EXTENSIONS = {"png", "gif", "webp"}


def emoji_upload_to(instance, filename: str) -> str:
    """MEDIA_ROOT/emoji/<токен>/<emoji|static>.<png|gif|webp>.

    Каталог на эмодзи по тем же причинам, что и у вложений (см.
    attachment_upload_to): без коллизий, с неугадываемым путём. Токен —
    отдельное поле, а не первичный ключ: ключ реакции выглядит как
    "custom:<id>" и должен оставаться коротким числом (см. chat.emoji), а
    неугадываемость нужна именно ПУТИ — /media/ отдаёт nginx без проверки прав.

    Имя файла, в отличие от вложений, НЕ человеческое и НЕ приходит от
    клиента — оно собирается здесь целиком. Причина ровно та же, по которой
    chat.uploads выбрасывает тип, выведенный из расширения: под /media/emoji/
    файлы отдаёт nginx НАПРЯМУЮ, и Content-Type он выбирает по расширению. Имя
    вроде "evil.html", протащенное мимо клиента (сам файл при этом остаётся
    валидным GIF — полиглоты существуют), отдавалось бы как документ на нашем
    же origin, где в localStorage лежит JWT. Показывать исходное имя эмодзи
    негде — у него есть собственное поле name, — так что терять тут нечего.
    """
    stem = "static" if filename.startswith("static") else "emoji"
    ext = filename.rpartition(".")[2].lower()
    if ext not in EMOJI_EXTENSIONS:
        ext = "png"
    return f"{EMOJI_SUBDIR}/{instance.file_token.hex}/{stem}.{ext}"


class ServerEmoji(models.Model):
    """Кастомный эмодзи сервера.

    Целочисленный первичный ключ, а не UUID, — сознательно: id уезжает в ключ
    реакции ("custom:42") и в токен внутри текста сообщения ("<:name:42>"),
    то есть хранится в БД по строке на каждую реакцию и на каждое упоминание.
    UUID раздул бы и то, и другое ради неугадываемости, которая здесь не
    нужна: эмодзи и так виден всем участникам сервера.

    animated + static_file — ради того, чтобы анимация НЕ игралась сама по
    себе. Анимированный эмодзи показывается первым кадром (static_file,
    статичный PNG), а сам GIF/WEBP клиент подгружает, только когда на эмодзи
    наводят или когда нажимают на реакцию с ним. Кадр вырезает клиент при
    загрузке (см. web/src/gif.ts — там уже есть покадровый разбор для
    анимированных аватаров): у бэкенда нет ни ffmpeg, ни причин его заводить.
    """

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="emoji")
    name = models.CharField(max_length=MAX_EMOJI_NAME_LEN)
    # Неугадываемая часть пути в /media — см. emoji_upload_to.
    file_token = models.UUIDField(default=uuid.uuid4, editable=False)
    file = models.FileField(upload_to=emoji_upload_to, max_length=300)
    # Первый кадр анимированного эмодзи. У статичных пуст — там показывать
    # по наведению нечего, file и есть статичная картинка.
    static_file = models.FileField(
        upload_to=emoji_upload_to, max_length=300, blank=True)
    animated = models.BooleanField(default=False)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    # Автор остаётся в истории после ухода с сервера — SET_NULL, а не CASCADE:
    # удалять чужие эмодзи вместе с аккаунтом значило бы ломать чужие старые
    # сообщения, где они стоят.
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="created_emoji")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            # Имя уникально в пределах сервера: в тексте эмодзи опознаётся по
            # id, но человек набирает ":имя:" и должен получать ровно один.
            models.UniqueConstraint(
                fields=["server", "name"], name="unique_server_emoji_name"),
        ]

    def __str__(self) -> str:
        return f":{self.name}: @ {self.server_id}"


@receiver(post_delete, sender=ServerEmoji)
def _cleanup_emoji_files(sender, instance, **kwargs):
    """Тот же приём, что и у вложений (см. _cleanup_attachment_file): сигнал, а
    не override delete(), — иначе удаление сервера каскадом унесло бы строки,
    оставив файлы лежать навсегда."""
    for field in (instance.file, instance.static_file):
        if field:
            field.delete(save=False)


STICKER_SUBDIR = "stickers"

# Потолок на один готовый стикер. Вдвое больше эмодзи и по обратной причине:
# стикер рисуется КРУПНО (см. STICKER_SIDE) и по одному на сообщение, а не
# десятками разом, поэтому лишние килобайты здесь не размножаются по экрану.
MAX_STICKER_BYTES = 512 * 1024
# Что вообще имеет смысл принять НА ВХОД: исходник ужимается до
# MAX_STICKER_BYTES уже здесь, на сервере (см. chat.stickers), так что
# входной файл заведомо крупнее результата. Больше 8 МБ — это уже не стикер,
# а видео, и читать его в память незачем.
MAX_STICKER_SOURCE_BYTES = 8 * 1024 * 1024
# Сторона готового стикера. 320, как у Discord/Telegram: крупнее его нигде не
# рисуют, а вес растёт квадратом стороны.
STICKER_SIDE = 320
# Сколько стикеров влезает в один набор и сколько наборов бывает у сервера.
# Ограничения ровно того же смысла, что MAX_EMOJI_PER_SERVER: ответ
# /api/stickers грузится клиентом целиком при старте.
MAX_STICKERS_PER_PACK = 120
MAX_STICKER_PACKS_PER_SERVER = 8

MAX_STICKER_NAME_LEN = 32
MIN_STICKER_NAME_LEN = 1
MAX_STICKER_PACK_NAME_LEN = 48

# Форматы, в которых стикер лежит на диске. Расширение здесь решает вопрос
# безопасности ровно так же, как у эмодзи (см. emoji_upload_to): под /media/
# файлы отдаёт nginx, и Content-Type он выбирает по расширению.
#
#   webp  — и статичный, и растровая анимация: всё, что пришло картинкой,
#           пережимается сюда (chat.stickers.prepare).
#   json  — Lottie: векторная анимация, которая весит килобайты вместо сотен
#           килобайт и не мылится ни на каком размере.
#   webm  — растровое видео с альфой: принимается как есть, перекодировать
#           его нечем (ffmpeg на бэкенде нет и заводить его ради стикеров
#           дороже, чем оно стоит).
STICKER_FORMATS = {
    "webp": "image/webp",
    "lottie": "application/json",
    "webm": "video/webm",
}
STICKER_EXTENSIONS = {"webp", "json", "webm"}


def sticker_upload_to(instance, filename: str) -> str:
    """MEDIA_ROOT/stickers/<токен>/<sticker|static>.<webp|json|webm>.

    Всё то же самое и по тем же причинам, что и у эмодзи (см.
    emoji_upload_to): каталог на стикер, неугадываемый токен в пути, имя файла
    собирается здесь целиком и никогда не приходит от клиента.
    """
    stem = "static" if filename.startswith("static") else "sticker"
    ext = filename.rpartition(".")[2].lower()
    if ext not in STICKER_EXTENSIONS:
        ext = "webp"
    return f"{STICKER_SUBDIR}/{instance.file_token.hex}/{stem}.{ext}"


class StickerPack(models.Model):
    """Набор стикеров — то, что в пикере становится отдельной вкладкой.

    Набор, а не «стикеры сервера», как у эмодзи, по двум причинам сразу.
    Во-первых, базовые наборы (server=None) вообще ничьи: они видны всем и
    всегда, и привязывать их к какому-то одному серверу было бы неправдой.
    Во-вторых, стикеров на сервере бывает не «пачка», а несколько тематических
    наборов — в отличие от эмодзи, где вкладкой служит сам сервер.
    """

    # None — базовый набор: доступен всем и везде, заводится администрацией
    # (см. manage.py import_stickers), а не участниками.
    server = models.ForeignKey(
        Server, null=True, blank=True, on_delete=models.CASCADE,
        related_name="sticker_packs")
    name = models.CharField(max_length=MAX_STICKER_PACK_NAME_LEN)
    # Порядок среди базовых наборов; серверные идут за ними в порядке рейла.
    sort_order = models.PositiveSmallIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="created_sticker_packs")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sort_order", "name", "id"]
        constraints = [
            # Имя уникально в пределах сервера (и среди базовых наборов —
            # там server_id один и тот же NULL... а NULL в UniqueConstraint не
            # сравнивается, поэтому базовые прикрыты отдельным условным
            # индексом ниже).
            models.UniqueConstraint(
                fields=["server", "name"], name="unique_server_sticker_pack"),
            models.UniqueConstraint(
                fields=["name"], condition=models.Q(server__isnull=True),
                name="unique_default_sticker_pack"),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({'базовый' if self.server_id is None else self.server_id})"


class Sticker(models.Model):
    """Один стикер.

    Целочисленный первичный ключ по той же причине, что у ServerEmoji: id
    уезжает в текст сообщения токеном "<sticker:42>" (см. chat.emoji
    STICKER_TOKEN_RE) и хранится в БД по строке на каждую отправку.

    Имя, в отличие от эмодзи, ничем не ограничено по алфавиту: оно НЕ попадает
    в токен (там только id), а служит подписью и словом для поиска — и «кот»
    кириллицей здесь куда полезнее, чем «kot».

    static_file — первый кадр растровой анимации; показывается в сетке пикера
    и в ленте, пока на стикер не навели. У Lottie и WebM его нет: первый кадр
    у них умеет показать сам клиент (lottie-web остановленный на нулевом кадре
    и <video> без autoplay), и гонять ради этого отдельный файл незачем.
    """

    pack = models.ForeignKey(
        StickerPack, on_delete=models.CASCADE, related_name="stickers")
    name = models.CharField(max_length=MAX_STICKER_NAME_LEN)
    file_token = models.UUIDField(default=uuid.uuid4, editable=False)
    file = models.FileField(upload_to=sticker_upload_to, max_length=300)
    static_file = models.FileField(
        upload_to=sticker_upload_to, max_length=300, blank=True)
    # Ключ STICKER_FORMATS — по нему клиент выбирает, чем рисовать.
    format = models.CharField(max_length=8, default="webp")
    animated = models.BooleanField(default=False)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="created_stickers")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]

    def __str__(self) -> str:
        return f"{self.name} @ {self.pack_id}"


@receiver(post_delete, sender=Sticker)
def _cleanup_sticker_files(sender, instance, **kwargs):
    """Сигнал, а не override delete(), — иначе удаление набора каскадом унесло
    бы строки, оставив файлы лежать навсегда (см. _cleanup_emoji_files)."""
    for field in (instance.file, instance.static_file):
        if field:
            field.delete(save=False)


class ProfileNote(models.Model):
    """Приватная заметка о другом пользователе — видна только автору (как
    заметки в профиле Discord). Одна заметка на пару (author, about) —
    повторная запись просто перезаписывает текст, отдельной истории нет.
    Видимость самого профиля (можно ли вообще оставить/прочитать заметку)
    проверяется тем же барьером, что и для карточки — см.
    chat.views._can_see_profile/UserNote."""

    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="notes_written")
    about = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="notes_about")
    text = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("author", "about")

    def __str__(self) -> str:
        return f"{self.author_id} note about {self.about_id}"


class FriendNickname(models.Model):
    """Никнейм, который ОДИН пользователь дал другому — как «дружеские
    прозвища» в Discord. Односторонний и приватный: его видит только тот, кто
    поставил, объекту никакого сигнала не уходит (тот же принцип, что у
    ProfileNote и UserRelationState выше).

    Одна запись на пару (owner, about); пустой никнейм не хранится вовсе —
    вместо записи с "" ручка удаляет строку (см. chat.views.UserNickname),
    иначе «убрал никнейм» оставлял бы за собой мусорную строку на каждую
    пару, которую кто-то когда-то трогал.
    """

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="nicknames_given")
    about = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="nicknames_received")
    nickname = models.CharField(max_length=64)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("owner", "about")

    def __str__(self) -> str:
        return f"{self.owner_id} calls {self.about_id} {self.nickname!r}"


# Опрос: границы. Не «на всякий случай», а чтобы одно сообщение не могло
# развернуться в простыню на весь экран у всех участников разом.
MAX_POLL_QUESTION_LEN = 300
MAX_POLL_OPTION_LEN = 100
MIN_POLL_OPTIONS = 2
MAX_POLL_OPTIONS = 10


class Poll(models.Model):
    """Опрос, приложенный к сообщению.

    Живёт НА сообщении, а не рядом с ним: опрос — это и есть содержимое
    сообщения, у него те же права, та же лента, то же удаление. Отдельной
    сущностью со своим списком и своими правами он был бы вторым чатом внутри
    чата.

    Два FK, как у Attachment выше и по той же причине: сообщения канала и
    лички — разные модели с независимой нумерацией id. Ровно один из них
    заполнен (см. constraint).

    Голоса не анонимны: кто за что проголосовал, видно (PollVote.user), как в
    Discord. Тайное голосование — другая фича с другими обещаниями, и
    подмешивать его сюда, не сказав об этом людям явно, нельзя.
    """

    message = models.OneToOneField(
        Message, null=True, blank=True, on_delete=models.CASCADE,
        related_name="poll")
    conversation_message = models.OneToOneField(
        ConversationMessage, null=True, blank=True, on_delete=models.CASCADE,
        related_name="poll")
    question = models.CharField(max_length=MAX_POLL_QUESTION_LEN)
    # Можно ли отметить несколько вариантов. Меняет смысл «процентов»: при
    # multiple сумма долей больше 100, и знаменателем считается число
    # ПРОГОЛОСОВАВШИХ, а не голосов (см. serializers).
    multiple = models.BooleanField(default=False)
    # Опрос закрыт: голоса видны, отдать новый нельзя. Ставится вручную
    # автором/модератором либо наступившим closes_at.
    closed = models.BooleanField(default=False)
    closes_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                # Ровно один владелец: без сообщения опрос не существует, а с
                # двумя — непонятно, в какой ленте он живёт.
                check=(
                    models.Q(message__isnull=False, conversation_message__isnull=True)
                    | models.Q(message__isnull=True, conversation_message__isnull=False)
                ),
                name="poll_single_owner",
            )
        ]

    def is_open(self) -> bool:
        """Принимает ли голоса прямо сейчас.

        Срок проверяется здесь, а не фоновым процессом: закрывать опросы по
        таймеру значит держать ещё один sweep ради того, что дешевле посчитать
        в момент вопроса.
        """
        if self.closed:
            return False
        if self.closes_at and timezone.now() >= self.closes_at:
            return False
        return True

    def __str__(self) -> str:
        return f"Опрос {self.question!r}"


class PollOption(models.Model):
    poll = models.ForeignKey(Poll, on_delete=models.CASCADE, related_name="options")
    text = models.CharField(max_length=MAX_POLL_OPTION_LEN)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:
        return self.text


class PollVote(models.Model):
    """Один голос за один вариант.

    unique_together (option, user), а не (poll, user): при multiple один
    человек отмечает несколько вариантов, и ограничение «один голос на опрос»
    запретило бы ровно то, ради чего multiple и нужен. «Один вариант на
    человека» в обычном опросе обеспечивается не схемой, а обработчиком (см.
    chat.consumers._cast_poll_vote): он снимает прежний голос перед новым.
    """

    option = models.ForeignKey(
        PollOption, on_delete=models.CASCADE, related_name="votes")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="poll_votes")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("option", "user")

    def __str__(self) -> str:
        return f"{self.user_id} -> {self.option_id}"


# Соундборд: границы. Длительность проверить нечем (ffmpeg в проекте нет — см.
# chat.uploads.sniff_sound), поэтому «короткий звук» задаётся размером файла.
# 512 КБ это несколько секунд в любом из принимаемых форматов.
MAX_SOUND_BYTES = 512 * 1024
MAX_SOUNDS_PER_SERVER = 40
MAX_SOUND_NAME_LEN = 32
MIN_SOUND_NAME_LEN = 2


def sound_upload_to(instance, filename: str) -> str:
    """MEDIA_ROOT/soundboard/<токен>/sound.<ext>.

    Имя и расширение собираются здесь целиком, клиентское не используется
    вовсе — ровно по той же причине, что у emoji_upload_to выше: под /media/
    файлы отдаёт nginx НАПРЯМУЮ и Content-Type выбирает по расширению.
    Валидный OGG под именем "evil.html" иначе уехал бы документом на нашем
    origin, где в localStorage лежит JWT.
    """
    from .uploads import SOUND_EXTENSIONS

    ext = SOUND_EXTENSIONS.get(instance.content_type, "bin")
    return f"soundboard/{instance.file_token}/sound.{ext}"


class SoundboardSound(models.Model):
    """Короткий звук соундборда — играет у всех, кто сейчас в том же голосовом
    канале.

    Звук НЕ подмешивается в аудиопоток SFU: он рассылается событием
    (soundboard_play), и каждый клиент проигрывает файл у себя. Так дешевле и
    честнее — микширование в mediasoup потребовало бы серверного аудиотракта
    (то есть ffmpeg, которого в проекте сознательно нет), а разницы на слух
    нет: в канале и так все слышат одно и то же с точностью до сетевой
    задержки.

    Побочный эффект приятный: у каждого работает своя громкость (см.
    web/src/userVolume.ts), и заглушивший звук соундборд не услышит вовсе.
    """

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="sounds")
    name = models.CharField(max_length=MAX_SOUND_NAME_LEN)
    # Эмодзи на кнопке — необязательный, чисто визуальный ярлык.
    emoji = models.CharField(max_length=8, blank=True, default="")
    # Неугадываемая часть пути в /media — см. sound_upload_to.
    file_token = models.UUIDField(default=uuid.uuid4, editable=False)
    content_type = models.CharField(max_length=100)
    file = models.FileField(upload_to=sound_upload_to, max_length=300)
    size = models.PositiveIntegerField()
    # Автор остаётся в истории после ухода с сервера — SET_NULL, как у
    # ServerEmoji: удалять чужие звуки вместе с аккаунтом незачем.
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="created_sounds")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["server", "name"], name="soundboard_name_unique_per_server"),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.server_id})"
