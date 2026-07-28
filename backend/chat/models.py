import uuid

from django.conf import settings
from django.db import models
from django.db.models.signals import post_delete
from django.dispatch import receiver
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
    порядок в UI) — chat.roles.PERMISSION_FIELDS; при добавлении права
    правьте оба места.
    """

    server = models.ForeignKey(
        Server, on_delete=models.CASCADE, related_name="roles")
    name = models.CharField(max_length=100)
    color = models.CharField(max_length=7, default="#99aab5")
    position = models.PositiveIntegerField(default=0)
    # Роль по умолчанию (аналог @everyone): её права действуют на всех
    # участников сервера, её нельзя удалить и не нужно никому выдавать.
    is_default = models.BooleanField(default=False)

    # --- общие права сервера ---
    view_channels = models.BooleanField(default=True)
    manage_channels = models.BooleanField(default=False)
    manage_roles = models.BooleanField(default=False)
    manage_server = models.BooleanField(default=False)
    manage_invites = models.BooleanField(default=False)
    manage_nicknames = models.BooleanField(default=False)
    # Выгонять/одобрять заявки/банить/разбанить участников.
    manage_members = models.BooleanField(default=False)

    # --- права текстового канала ---
    send_messages = models.BooleanField(default=True)
    delete_messages = models.BooleanField(default=False)
    mention_everyone = models.BooleanField(default=False)

    # --- права голосового канала ---
    speak = models.BooleanField(default=True)
    video = models.BooleanField(default=True)

    class Meta:
        ordering = ["-position", "id"]

    def __str__(self) -> str:
        return f"{self.name} @ {self.server_id}"


class Membership(models.Model):
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

    class Meta:
        unique_together = ("user", "server")

    def __str__(self) -> str:
        return f"{self.user} @ {self.server}"


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


class Channel(models.Model):
    TEXT = "text"
    VOICE = "voice"
    KIND_CHOICES = [(TEXT, "Text"), (VOICE, "Voice")]

    server = models.ForeignKey(
        Server,
        on_delete=models.CASCADE,
        related_name="channels",
    )
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, default=TEXT)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:
        return f"{self.server.name}#{self.name}"


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

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self) -> str:
        return f"{self.author}: {self.content[:30]}"


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

    class Meta:
        unique_together = ("conversation", "user")

    def __str__(self) -> str:
        return f"{self.user} in {self.conversation}"


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
