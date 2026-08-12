from rest_framework import serializers

from accounts.serializers import (
    ALLOWED_AVATAR_MIME, ALLOWED_BANNER_MIME, GRADIENT_RE, MAX_BANNER_BYTES,
    UserSerializer, validate_data_url,
)

from . import presence, roles
from .models import (
    Attachment, Channel, ChannelCategory, Conversation, ConversationMessage,
    ConversationParticipant, Membership,
    Message, Role, Server, ServerAuditLog, ServerBan, ServerEmoji, ServerInvite,
    ServerJoinRequest, SoundboardSound, Sticker, StickerPack, dm_room,
)

# Значок сервера жмётся клиентом до 512x512 (ServerSettingsModal.ICON_SIZE) —
# лимит тот же по смыслу, что и у аватара пользователя: защита от запросов
# в обход клиента, а не рабочий предел.
MAX_ICON_BYTES = 1_500_000

# Сколько символов последнего сообщения ветки уезжает в плашку под исходным
# сообщением (см. ChannelSerializer.get_last_message). Строка в плашке одна,
# и всё сверх неё всё равно обрезается многоточием уже на экране.
THREAD_PREVIEW_CHARS = 120

# Сколько «особенностей»/правил вообще имеет смысл хранить — не техническое
# ограничение, а защита от бесконечного списка в JSONField.
MAX_TAGS = 12
MAX_TAG_LEN = 32
MAX_RULES = 20


class ChannelCategorySerializer(serializers.ModelSerializer):
    """Раздел сайдбара. Каналы сюда НЕ вкладываются: они и так приезжают
    плоским списком в ServerSerializer.channels со своим category, а вложить
    их ещё и сюда значило бы гонять один и тот же объект дважды и потом
    следить, чтобы две копии не разошлись."""

    class Meta:
        model = ChannelCategory
        fields = ["id", "server", "name", "position"]
        read_only_fields = ["id", "server"]


class ChannelSerializer(serializers.ModelSerializer):
    # Длительность текущего разговора и статус — только для голосовых
    # каналов, живут в presence (Redis), пока в канале кто-то есть.
    call_started_at = serializers.SerializerMethodField()
    topic = serializers.SerializerMethodField()
    # Кому открыт приватный канал. Плоским списком id, а не вложенными ролями/
    # людьми: сами роли клиент уже держит (api.roles), участников — из ростера
    # сервера, а тут нужна только связь.
    allowed_role_ids = serializers.SerializerMethodField()
    allowed_user_ids = serializers.SerializerMethodField()
    my_settings = serializers.SerializerMethodField()
    # Для плашки ветки под исходным сообщением (см. web MessageList): сколько
    # в ней сообщений и какое последнее. Только у веток.
    message_count = serializers.SerializerMethodField()
    last_message = serializers.SerializerMethodField()
    joined = serializers.SerializerMethodField()

    class Meta:
        model = Channel
        fields = ["id", "server", "name", "kind", "position", "category",
                  "call_started_at", "topic", "status", "slowmode_seconds",
                  "is_spoiler", "age_restricted", "is_private", "allowed_role_ids",
                  "allowed_user_ids", "invites_paused", "my_settings",
                  # Только у веток (kind=thread), у остальных каналов пусто —
                  # см. Channel.parent/source_message/archived/created_by.
                  "parent", "source_message", "archived", "created_by",
                  "invite_only", "locked",
                  "message_count", "last_message", "joined"]
        read_only_fields = ["server", "parent", "source_message", "created_by",
                            "message_count", "last_message", "joined"]

    def get_message_count(self, obj):
        """Сколько сообщений в ветке — цифра в плашке «N сообщений ›».

        thread_counts в контексте — заранее посчитанные счётчики на весь
        список (см. chat.views.thread_stats_context): без него на каждую ветку
        уходил бы свой COUNT. Контекста нет (одиночная сериализация после
        создания/правки) — считаем на месте, это один запрос на одну ветку.
        """
        if obj.kind != Channel.THREAD:
            return 0
        counts = self.context.get("thread_counts")
        if counts is not None:
            return counts.get(obj.id, 0)
        return obj.messages.count()

    def get_last_message(self, obj):
        """Последнее сообщение ветки — превью в плашке (кто и что написал).

        Обрезано по длине: в плашку помещается одна строка, а тащить в список
        каналов сервера полные тексты со всеми вложениями и реакциями значило
        бы раздувать payload ради превью.
        """
        if obj.kind != Channel.THREAD:
            return None
        latest = self.context.get("thread_last_messages")
        message = (
            latest.get(obj.id) if latest is not None
            else obj.messages.select_related("author").order_by("-id").first()
        )
        if message is None:
            return None
        return {
            "id": message.id,
            "author": UserSerializer(message.author).data,
            "content": message.content[:THREAD_PREVIEW_CHARS],
            # Через поле DRF, а не сырым datetime: этот словарь собран руками, и
            # автоматического приведения типов у него нет — а payload уезжает не
            # только в JSON-ответ, но и в WebSocket, где его пакует msgpack,
            # datetime не умеющий вовсе (channels_redis). Заодно формат даты
            # выходит тот же, что у всех остальных дат API.
            "created_at": serializers.DateTimeField().to_representation(
                message.created_at),
        }

    def get_joined(self, obj):
        """Участвую ли я в этой ветке — от этого зависит, висит ли она в
        сайдбаре (там только свои, см. chat.models.ThreadMember) и что
        предлагает меню: «Присоединиться» или «Покинуть»."""
        if obj.kind != Channel.THREAD:
            return False
        joined_ids = self.context.get("joined_thread_ids")
        if joined_ids is not None:
            return obj.id in joined_ids
        request = self.context.get("request")
        if request is None or not request.user or not request.user.is_authenticated:
            return False
        from .models import ThreadMember

        return ThreadMember.objects.filter(thread=obj, user=request.user).exists()

    def _state(self, obj):
        """Состояние звонка канала. Если вызывающий заранее сложил в контекст
        call_states (см. chat.views.server_context), берём оттуда — иначе на
        каждый голосовой канал уходило бы по два отдельных обращения к Redis
        прямо во время сериализации."""
        states = self.context.get("call_states")
        if states is not None:
            return states.get(str(obj.id)) or {"call_started_at": None, "topic": None}
        return presence.call_state(obj.id)

    def get_allowed_role_ids(self, obj):
        if not obj.is_private:
            return []
        return [r.id for r in obj.allowed_roles.all()]

    def get_allowed_user_ids(self, obj):
        if not obj.is_private:
            return []
        return [u.id for u in obj.allowed_users.all()]

    def get_call_started_at(self, obj):
        if obj.kind != Channel.VOICE:
            return None
        return self._state(obj)["call_started_at"]

    def get_topic(self, obj):
        if obj.kind != Channel.VOICE:
            return None
        return self._state(obj)["topic"]

    def get_my_settings(self, obj):
        """Личные настройки запрашивающего для ЭТОГО канала (уведомления,
        заглушение) — см. channel_member_settings_payload. channel_settings в
        контексте — заранее собранный словарь {channel_id: ChannelMemberSettings}
        (см. chat.views.server_context): без него на каждый канал в списке
        уходил бы свой запрос."""
        settings_map = self.context.get("channel_settings")
        if settings_map is not None:
            return channel_member_settings_payload(settings_map.get(obj.id))
        request = self.context.get("request")
        if request is None or not request.user or not request.user.is_authenticated:
            return channel_member_settings_payload(None)
        from .models import ChannelMemberSettings
        found = ChannelMemberSettings.objects.filter(
            user=request.user, channel=obj).first()
        return channel_member_settings_payload(found)


class RoleSerializer(serializers.ModelSerializer):
    # Кто может пинговать ЭТУ роль (@ИмяРоли) — см. Role.mentionable_by.
    # queryset сужается до ролей ТОГО ЖЕ сервера в __init__ (нужен server в
    # context) — без этого можно было бы сослаться на роль чужого сервера.
    # Пустой queryset() по умолчанию — предохранитель: если вызывающий забыл
    # передать context, любой переданный id просто не пройдёт валидацию,
    # вместо того чтобы молча принять роль откуда угодно.
    mentionable_by = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Role.objects.none())

    class Meta:
        model = Role
        fields = ["id", "name", "color", "position", "is_default", "is_owner_role",
                  "mention_permission", "mentionable_by",
                  *roles.PERMISSION_NAMES]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        server = self.context.get("server")
        if server is not None:
            # many=True оборачивает поле в ManyRelatedField — сам queryset,
            # который реально смотрит to_internal_value(), живёт на
            # child_relation, а не на обёртке; поставить его на обёртку —
            # завести атрибут, который никто не читает, и queryset молча
            # останется прежним (Role.objects.none() из объявления поля).
            self.fields["mentionable_by"].child_relation.queryset = (
                Role.objects.filter(server=server))

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Нужно название роли.")
        return value


def membership_settings_payload(membership: Membership) -> dict:
    """Личные настройки уведомлений/приватности участника для его сервера —
    общая форма и для ServerSerializer.my_settings (отдаётся со списком
    серверов сразу), и для ответа chat.views.MyServerSettings (после PATCH).
    Единое место, чтобы оба не разъехались по набору полей."""
    return {
        "notification_level": membership.notification_level,
        "muted": membership.is_muted(),
        "muted_until": membership.muted_until,
        "muted_forever": membership.muted_forever,
        "ignore_at_here": membership.ignore_at_here,
        "suppress_role_mentions": membership.suppress_role_mentions,
        "allow_dms_from_server": membership.allow_dms_from_server,
        "pinned_channel_ids": membership.pinned_channel_ids,
    }


def _default_membership_settings_payload() -> dict:
    """Тот же контракт для не-участника/анонимного запроса — например, когда
    ServerSerializer сериализуется без request в контексте (рассылка по WS)."""
    return {
        "notification_level": Membership.NOTIFY_ALL,
        "muted": False,
        "muted_until": None,
        "muted_forever": False,
        "ignore_at_here": False,
        "suppress_role_mentions": False,
        "allow_dms_from_server": True,
        "pinned_channel_ids": [],
    }


class ServerSerializer(serializers.ModelSerializer):
    # Не ChannelSerializer(many=True) напрямую: приватные каналы (см.
    # Channel.is_private) видны не всем, и список надо фильтровать под
    # запрашивающего. Без request в контексте (рассылка через WS) приватных
    # не отдаём вовсе — получатель там неизвестен, и «показать на всякий
    # случай» означало бы утечку.
    channels = serializers.SerializerMethodField()
    # Разделы сайдбара. Отдаются ВСЕ, без фильтрации по видимости: категория
    # сама по себе ничего не скрывает и ничего не выдаёт, кроме своего
    # названия, а фронту нужен полный список, чтобы отрисовать порядок групп.
    # Пустой раздел (все каналы внутри приватные и не видны) фронт просто не
    # показывает — см. web ChannelSidebar.
    categories = ChannelCategorySerializer(many=True, read_only=True)
    # Права ЗАПРАШИВАЮЩЕГО на этом сервере — фронт по ним решает, показывать
    # ли шестерёнку редактора, кнопку «+ канал» и т.п. Без request в
    # контексте (например, при рассылке через WS) прав нет — фронт в таких
    # местах и так использует уже загруженный объект сервера.
    my_permissions = serializers.SerializerMethodField()
    # Личные настройки уведомлений/мьюта/приватности запрашивающего — та же
    # логика "без request — нейтральный дефолт", что и у my_permissions.
    my_settings = serializers.SerializerMethodField()
    member_count = serializers.SerializerMethodField()

    class Meta:
        model = Server
        fields = [
            "id", "name", "owner", "created_at", "channels", "categories", "icon",
            "banner_gradient", "banner_image", "description", "tags",
            "is_private", "access_mode", "age_restricted", "rules",
            "my_permissions", "my_settings", "member_count",
        ]
        read_only_fields = ["owner", "created_at"]

    def get_channels(self, obj):
        from .permissions import visible_channels

        # Архивные ветки отсюда НЕ вырезаются, хотя в сайдбаре их и не видно
        # (фильтрует фронт, см. Channel.archived). Так плашка «Ветка: имя» под
        # исходным сообщением продолжает работать и после закрытия ветки, а
        # список «Архивные ветки» в меню канала обходится вообще без своей
        # ручки — он фильтр по уже загруженному списку. Payload от этого
        # растёт с числом когда-либо закрытых обсуждений, но в масштабе
        # сервера для друзей это единицы строк, а не тот случай, ради которого
        # заводят отдельную пагинированную ручку.
        channels = list(obj.channels.all())
        request = self.context.get("request")
        if request is None:
            channels = [c for c in channels if not c.is_private]
        else:
            channels = visible_channels(request.user, obj, channels)
        return ChannelSerializer(channels, many=True, context=self.context).data

    def get_my_permissions(self, obj):
        request = self.context.get("request")
        if request is None:
            return roles.no_permissions()
        return roles.permissions_for(request.user, obj)

    def get_my_settings(self, obj):
        request = self.context.get("request")
        if request is None or not request.user or not request.user.is_authenticated:
            return _default_membership_settings_payload()
        # Предпочитаем контекст, собранный одним пайплайном на весь список
        # серверов (см. chat.views.server_context) — без него на каждый
        # сервер уходил бы отдельный запрос Membership.
        cache = self.context.get("my_memberships")
        membership = (
            cache.get(obj.id) if cache is not None
            else Membership.objects.filter(user=request.user, server=obj).first()
        )
        if membership is None:
            return _default_membership_settings_payload()
        return membership_settings_payload(membership)

    def get_member_count(self, obj):
        # Предпочитаем аннотацию из queryset'а (см. chat.views) — без неё на
        # каждый сервер в списке уходил отдельный COUNT.
        annotated = getattr(obj, "member_total", None)
        if annotated is not None:
            return annotated
        return obj.memberships.count()


class ServerUpdateSerializer(serializers.ModelSerializer):
    """PATCH /api/servers/<id> — вкладки «Профиль» и «Доступ» редактора."""

    class Meta:
        model = Server
        fields = [
            "name", "icon", "banner_gradient", "banner_image", "description",
            "tags", "is_private", "access_mode", "age_restricted", "rules",
        ]
        extra_kwargs = {field: {"required": False} for field in fields}

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Имя сервера не может быть пустым.")
        return value

    def validate_icon(self, value):
        return validate_data_url(
            value, ALLOWED_AVATAR_MIME, MAX_ICON_BYTES, "значок сервера")

    def validate_banner_image(self, value):
        return validate_data_url(
            value, ALLOWED_BANNER_MIME, MAX_BANNER_BYTES, "баннер сервера")

    def validate_banner_gradient(self, value):
        if value and not GRADIENT_RE.match(value):
            raise serializers.ValidationError("Некорректный формат градиента.")
        return value

    def validate_tags(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Особенности — список строк.")
        cleaned = []
        for tag in value:
            if not isinstance(tag, str):
                raise serializers.ValidationError("Особенности — список строк.")
            tag = tag.strip()[:MAX_TAG_LEN]
            if tag and tag not in cleaned:
                cleaned.append(tag)
        return cleaned[:MAX_TAGS]

    def validate_rules(self, value):
        """Правила — список {"title", "text"}; лишние ключи отбрасываем,
        чтобы в JSONField не попадало что попало из запроса."""
        if not isinstance(value, list):
            raise serializers.ValidationError("Правила — список объектов.")
        cleaned = []
        for rule in value[:MAX_RULES]:
            if not isinstance(rule, dict):
                raise serializers.ValidationError("Правило — объект.")
            title = str(rule.get("title", "")).strip()[:120]
            text = str(rule.get("text", "")).strip()[:2000]
            if title or text:
                cleaned.append({"title": title, "text": text})
        return cleaned


class ServerJoinRequestSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = ServerJoinRequest
        fields = ["id", "user", "message", "created_at"]


class ServerBanSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)
    banned_by = UserSerializer(read_only=True)

    class Meta:
        model = ServerBan
        fields = ["id", "user", "banned_by", "reason", "created_at"]


class ServerAuditLogSerializer(serializers.ModelSerializer):
    """Запись журнала модерации для панели модератора (см.
    chat.views.ServerMemberModeratorView).

    actor отдаётся целиком (нужны аватар и имя рядом с действием), target —
    нет: панель всегда открыта НА конкретном участнике, и повторять его в
    каждой строке незачем. details уходит как есть — его форма своя у
    каждого действия, разбирает её фронт (см. ModeratorPanel.tsx).
    """

    actor = UserSerializer(read_only=True)

    class Meta:
        model = ServerAuditLog
        fields = ["id", "actor", "action", "details", "created_at"]


class MembershipSettingsSerializer(serializers.ModelSerializer):
    """PATCH /api/servers/<id>/settings — только «плоские» настройки.

    Заглушение (muted_until/muted_forever) сюда намеренно не входит: это не
    поле, а ДЕЙСТВИЕ ("заглушить на 30 минут" / "навсегда" / "снять"),
    которое chat.views.MyServerSettings разбирает из mute_minutes/
    mute_forever/unmute и переводит в эти два поля сам — см. вьюху.
    """

    class Meta:
        model = Membership
        fields = [
            "notification_level", "ignore_at_here", "suppress_role_mentions",
            "allow_dms_from_server", "pinned_channel_ids",
        ]
        extra_kwargs = {field: {"required": False} for field in fields}

    def validate_pinned_channel_ids(self, value):
        if not isinstance(value, list) or not all(isinstance(v, int) for v in value):
            raise serializers.ValidationError("Список id каналов (целые числа).")
        # Закрепить можно только реальный канал СВОЕГО ЖЕ сервера — иначе
        # чужой/несуществующий id тихо осел бы в списке и ничего полезного не
        # показывал (или, того хуже, ссылался бы на канал другого сервера).
        server = self.instance.server
        valid_ids = set(server.channels.values_list("id", flat=True))
        if not set(value).issubset(valid_ids):
            raise serializers.ValidationError("Один из каналов не найден на этом сервере.")
        return value


def channel_member_settings_payload(settings_obj: "ChannelMemberSettings | None") -> dict:
    """Личные настройки уведомлений/заглушения участника для ОДНОГО канала —
    общая форма и для ChannelSerializer.my_settings (уходит вместе со списком
    каналов), и для ответа ChannelMemberSettingsView. Тот же приём, что и
    membership_settings_payload у Membership, см. её докстринг.

    settings_obj=None — участник для этого канала ничего не переопределял:
    отсутствие строки в БД и есть «стандартные настройки» (см.
    ChannelMemberSettings docstring), а не повод создавать её заранее.
    """
    from .models import ChannelMemberSettings

    if settings_obj is None:
        return {
            "notification_level": ChannelMemberSettings.NOTIFY_DEFAULT,
            "muted": False,
            "muted_until": None,
            "muted_forever": False,
        }
    return {
        "notification_level": settings_obj.notification_level,
        "muted": settings_obj.is_muted(),
        "muted_until": settings_obj.muted_until,
        "muted_forever": settings_obj.muted_forever,
    }


class ChannelMemberSettingsSerializer(serializers.ModelSerializer):
    """PATCH /api/channels/<id>/settings — только notification_level; мьют —
    ДЕЙСТВИЕ (mute_minutes/mute_forever/unmute), как и у MembershipSettingsSerializer,
    см. её докстринг — та же причина."""

    class Meta:
        from .models import ChannelMemberSettings
        model = ChannelMemberSettings
        fields = ["notification_level"]
        extra_kwargs = {"notification_level": {"required": False}}


class ServerInviteSerializer(serializers.ModelSerializer):
    """Личное приглашение — ответ на POST /api/servers/<id>/invites и на
    GET /api/invites (см. chat.views.MyServerInvites). Ссылки (kind=LINK)
    этим сериализатором не отдаются — у них другой, более узкий ответ (см.
    ServerInviteLink). Само приглашение адресат теперь видит карточкой в
    переписке — см. ConversationServerInviteSerializer."""

    created_by = UserSerializer(read_only=True)
    server = serializers.SerializerMethodField()
    channel = serializers.SerializerMethodField()

    class Meta:
        model = ServerInvite
        fields = ["id", "server", "channel", "created_by", "created_at", "status"]

    def get_server(self, obj):
        # Компактно и без контекста запроса: этому серверу приглашённый
        # ещё не участник, полноценный ServerSerializer.my_permissions/
        # my_settings ему тут ни к чему, а лишний вес (все каналы) — тем
        # более.
        return {"id": obj.server_id, "name": obj.server.name, "icon": obj.server.icon}

    def get_channel(self, obj):
        if obj.channel_id is None:
            return None
        return {"id": obj.channel_id, "name": obj.channel.name}


class ChannelInviteSerializer(serializers.ModelSerializer):
    """Одна строка вкладки «Приглашения» в ChannelSettingsModal — кому и
    когда отправили личное приглашение именно в этот канал, и решено ли оно
    (см. chat.views.ChannelInvitesList)."""

    invited_user = UserSerializer(read_only=True)

    class Meta:
        model = ServerInvite
        fields = ["id", "invited_user", "status", "created_at"]


class ServerInviteLinkSerializer(serializers.ModelSerializer):
    """Одна ссылка-приглашение (kind=LINK) для GET /api/servers/<id>/invite-links
    (см. chat.views.ServerInviteLinksList) — модераторский список ВСЕХ
    ссылок сервера, у каждого участника своя (см. created_by в lookup'е
    ServerInviteLink.get), с числом реально вступивших по ней (uses)."""

    created_by = UserSerializer(read_only=True)
    channel = serializers.SerializerMethodField()

    class Meta:
        model = ServerInvite
        fields = ["id", "code", "channel", "created_by", "uses", "created_at"]

    def get_channel(self, obj):
        if obj.channel_id is None:
            return None
        return {"id": obj.channel_id, "name": obj.channel.name}


class ConversationServerInviteSerializer(serializers.ModelSerializer):
    """Приглашение как оно встроено КАРТОЧКОЙ в сообщение диалога (см.
    ConversationMessageSerializer.server_invite) — компактнее
    ServerInviteSerializer: без created_by (это и так автор сообщения) и с
    member_count, чтобы карточка сама показывала, куда зовут."""

    server = serializers.SerializerMethodField()
    channel = serializers.SerializerMethodField()

    class Meta:
        model = ServerInvite
        fields = ["id", "status", "server", "channel"]

    def get_server(self, obj):
        return {
            "id": obj.server_id,
            "name": obj.server.name,
            "icon": obj.server.icon,
            "member_count": obj.server.memberships.count(),
        }

    def get_channel(self, obj):
        if obj.channel_id is None:
            return None
        return {"id": obj.channel_id, "name": obj.channel.name}


class AttachmentSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = Attachment
        fields = ["id", "url", "original_name", "content_type", "size",
                  "width", "height", "voice", "duration_ms", "waveform"]

    def get_url(self, obj):
        """Путь относительно корня (`/media/...`), а не абсолютный URL.

        Абсолютный пришлось бы собирать из request.build_absolute_uri, а
        сериализатор работает и без request — тем же объектом сообщение
        рассылается по WebSocket (см. chat.consumers). Домен подставляет
        клиент: тот же base, что у API (см. web/src/api.ts mediaUrl).
        """
        return obj.file.url if obj.file else ""


class SoundboardSoundSerializer(serializers.ModelSerializer):
    """Звук соундборда. Сам файл клиент грузит по url и играет у себя — в
    аудиопоток SFU он не подмешивается (см. chat.models.SoundboardSound)."""

    url = serializers.SerializerMethodField()

    class Meta:
        model = SoundboardSound
        fields = ["id", "name", "emoji", "server", "url", "size",
                  "created_by", "created_at"]
        read_only_fields = fields

    # Путь от корня, а не абсолютный URL — по той же причине, что у эмодзи и
    # вложений: тот же объект уезжает по WebSocket, где request'а нет.
    def get_url(self, obj):
        return obj.file.url if obj.file else ""


class ServerEmojiSerializer(serializers.ModelSerializer):
    """Кастомный эмодзи в том виде, в каком его получает клиент.

    Два URL, а не один: static_url — это первый кадр анимированного эмодзи, и
    именно он показывается по умолчанию. Сам url клиент подставляет, только
    когда на эмодзи навели (или нажали на реакцию) — см. web/src/components/
    CustomEmojiImage.tsx. У статичных эмодзи static_url совпадает с url, чтобы
    у отрисовки был ровно один вход и ей не приходилось выбирать поле.
    """

    url = serializers.SerializerMethodField()
    static_url = serializers.SerializerMethodField()
    server_name = serializers.CharField(source="server.name", read_only=True)

    class Meta:
        model = ServerEmoji
        fields = ["id", "name", "server", "server_name", "url", "static_url",
                  "animated", "size", "created_by", "created_at"]
        read_only_fields = fields

    # Путь от корня, а не абсолютный URL — по той же причине, что у вложений
    # (см. AttachmentSerializer.get_url): тот же объект уезжает по WebSocket.
    def get_url(self, obj):
        return obj.file.url if obj.file else ""

    def get_static_url(self, obj):
        if obj.animated and obj.static_file:
            return obj.static_file.url
        return obj.file.url if obj.file else ""


class StickerSerializer(serializers.ModelSerializer):
    """Стикер в том виде, в каком его получает клиент.

    static_url — первый кадр растровой анимации; он же показывается в сетке
    пикера и в ленте, пока на стикер не навели (анимация по требованию —
    ровно та же логика, что у кастомных эмодзи, см. CustomEmojiImage). У
    Lottie и WebM он пуст: первый кадр там рисует сам клиент, отдельного файла
    для этого не нужно.
    """

    url = serializers.SerializerMethodField()
    static_url = serializers.SerializerMethodField()

    class Meta:
        model = Sticker
        fields = ["id", "name", "pack", "url", "static_url", "format",
                  "animated", "size", "created_by", "created_at"]
        read_only_fields = fields

    # Путь от корня, а не абсолютный URL — тот же объект уезжает по WebSocket
    # (см. AttachmentSerializer.get_url).
    def get_url(self, obj):
        return obj.file.url if obj.file else ""

    def get_static_url(self, obj):
        if obj.static_file:
            return obj.static_file.url
        # У статичного стикера первый кадр и есть сам файл; у Lottie/WebM тут
        # пусто, и клиент это различает по полю format.
        return "" if obj.animated else (obj.file.url if obj.file else "")


class StickerPackSerializer(serializers.ModelSerializer):
    """Набор стикеров вместе со всем содержимым — одной вкладкой пикера.

    Стикеры вложены, а не отдельным запросом: набор небольшой (см.
    MAX_STICKERS_PER_PACK), а вкладка без содержимого бесполезна — её всё
    равно тут же пришлось бы догружать.

    Права («могу ли я тут удалять») сюда не кладутся: один и тот же объект
    уходит broadcast'ом всем участникам сервера, как и набор эмодзи. Клиент
    считает их сам, сверяя pack.server со списком своих серверов.
    """

    stickers = StickerSerializer(many=True, read_only=True)
    server_name = serializers.CharField(
        source="server.name", read_only=True, default="")

    class Meta:
        model = StickerPack
        fields = ["id", "name", "server", "server_name", "sort_order",
                  "stickers"]
        read_only_fields = fields


def reactions_payload(reactions) -> list:
    """[{"emoji": ..., "count": N, "user_ids": [...]}, ...] в порядке первого
    появления эмодзи.

    user_ids, а не готовый флаг «моя реакция»: ОДИН и тот же сериализованный
    объект сообщения уходит broadcast'ом всем сразу (chat.consumers), так что
    поля, зависящего от получателя, здесь быть не может в принципе. Клиент
    сам сверяет список со своим id — заодно это даёт подсказку «кто поставил»
    без отдельного запроса.

    Принимает готовую последовательность, а не queryset: вызывающие отдают
    сюда obj.reactions.all(), которая при prefetch_related уже в памяти (см.
    chat.views — иначе на каждое сообщение в истории уходил бы свой запрос).
    """
    grouped: dict[str, list] = {}
    for reaction in reactions:
        grouped.setdefault(reaction.emoji, []).append(reaction.user_id)
    return [
        {"emoji": emoji, "count": len(user_ids), "user_ids": user_ids}
        for emoji, user_ids in grouped.items()
    ]


class MessageReplySerializer(serializers.ModelSerializer):
    """Компактный превью сообщения, на которое отвечают — без вложенности."""
    author = UserSerializer(read_only=True)

    class Meta:
        model = Message
        fields = ["id", "author", "content"]


class ThreadNoticeSerializer(serializers.ModelSerializer):
    """Ветка внутри системной записи «X начинает ветку» — только то, чем эта
    строка кликабельна: имя на экране и id, чтобы открыть панель. Полный
    ChannelSerializer сюда не годится — он тянет за собой состояние звонка,
    списки допусков и превью последнего сообщения ради одной ссылки."""

    class Meta:
        model = Channel
        fields = ["id", "name", "archived"]


def poll_payload(poll):
    """Опрос для клиента: варианты и кто за что проголосовал.

    Одинаковый для ВСЕХ получателей — намеренно. «Мой голос» здесь не
    вычисляется: обновления опроса уходят одной рассылкой на всю группу
    канала (см. chat.consumers._broadcast_poll), и поле, у каждого своё,
    заставило бы собирать payload на каждого участника отдельно. Клиент
    выводит его сам из voter_ids, где и так уже есть всё нужное.

    Счётчики считаются здесь, а не хранятся денормализованно в PollOption:
    голосов на опрос — десятки, пересчёт стоит одного запроса, а
    рассинхронизировавшийся счётчик пришлось бы чинить руками.

    total_voters отдельно от total_votes нужен из-за multiple: там один
    человек отмечает несколько вариантов, и знаменателем у процентов должно
    быть число ПРОГОЛОСОВАВШИХ, иначе сумма долей уходит в потолок при том,
    что проголосовало трое.
    """
    options = []
    voter_ids = set()
    for option in poll.options.all():
        votes = list(option.votes.all())
        voter_ids.update(v.user_id for v in votes)
        options.append({
            "id": option.id,
            "text": option.text,
            "votes": len(votes),
            "voter_ids": [v.user_id for v in votes],
        })
    return {
        "id": poll.id,
        "question": poll.question,
        "multiple": poll.multiple,
        "open": poll.is_open(),
        "closes_at": poll.closes_at,
        "options": options,
        "total_votes": sum(o["votes"] for o in options),
        "total_voters": len(voter_ids),
    }


class PollField(serializers.Field):
    """Опрос внутри сообщения — только на чтение.

    Своё поле, а не вложенный ModelSerializer: payload собирается функцией
    выше, которую зовут ещё и из консьюмера при рассылке обновлений, — и
    расходиться этим двум представлениям нельзя.
    """

    def __init__(self, **kwargs):
        kwargs.setdefault("read_only", True)
        kwargs.setdefault("source", "*")
        super().__init__(**kwargs)

    def to_representation(self, message):
        poll = getattr(message, "poll", None)
        return None if poll is None else poll_payload(poll)


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    reply_to = MessageReplySerializer(read_only=True)
    attachments = AttachmentSerializer(many=True, read_only=True)
    reactions = serializers.SerializerMethodField()
    poll = PollField()

    # Наружу отдаём именно булев «закреплено» (Message.pinned) — фронту
    # незачем знать, что внутри лежит момент закрепления.
    pinned = serializers.BooleanField(read_only=True)

    # Системная запись («X начинает ветку»): пусто у обычных сообщений. Текст
    # собирает клиент из этих полей, а не берёт из content — иначе он был бы
    # прибит к языку, на котором его сочинили в момент создания (см.
    # chat.models.Message.system_kind).
    system_thread = ThreadNoticeSerializer(read_only=True)

    class Meta:
        model = Message
        fields = ["id", "channel", "author", "content", "reply_to",
                  "attachments", "reactions", "created_at", "edited_at",
                  "pinned", "system_kind", "system_thread", "poll"]
        read_only_fields = ["author", "created_at", "edited_at", "pinned",
                            "system_kind", "system_thread"]

    def get_reactions(self, obj):
        return reactions_payload(obj.reactions.all())


class ConversationMessageReplySerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)

    class Meta:
        model = ConversationMessage
        fields = ["id", "author", "content"]


class ConversationMessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    reply_to = ConversationMessageReplySerializer(read_only=True)
    attachments = AttachmentSerializer(many=True, read_only=True)
    reactions = serializers.SerializerMethodField()
    server_invite = ConversationServerInviteSerializer(read_only=True)
    poll = PollField()

    class Meta:
        model = ConversationMessage
        fields = ["id", "conversation", "author", "content", "reply_to",
                  "attachments", "reactions", "server_invite", "created_at",
                  "edited_at", "poll"]
        read_only_fields = ["author", "created_at", "edited_at"]

    def get_reactions(self, obj):
        return reactions_payload(obj.reactions.all())


class ConversationSerializer(serializers.ModelSerializer):
    # Собеседник(и) без себя самого — фронту не нужно самому себя вычитать
    # из списка при отрисовке заголовка/аватара диалога.
    participants = serializers.SerializerMethodField()
    last_message = serializers.SerializerMethodField()
    # Звонок в этом диалоге/группе живёт в том же presence, что и голосовые
    # каналы серверов — просто под синтетическим room (см. models.dm_room).
    call_started_at = serializers.SerializerMethodField()

    # Личные настройки ЭТОЙ беседы у того, кто её запрашивает (закрепление,
    # см. ConversationParticipant) — как my_settings у сервера.
    pinned = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = ["id", "kind", "name", "created_at", "participants",
                  "last_message", "call_started_at", "pinned"]

    def get_pinned(self, obj) -> bool:
        request = self.context.get("request")
        if request is None:
            return False
        # Карта участий, если вызывающий сложил её в контекст одним запросом
        # (см. chat.views.conversation_context) — иначе точечный запрос.
        memberships = self.context.get("my_memberships")
        if memberships is not None:
            membership = memberships.get(obj.id)
            return bool(membership and membership.pinned)
        return ConversationParticipant.objects.filter(
            conversation=obj, user=request.user, pinned=True).exists()

    def get_participants(self, obj):
        request = self.context.get("request")
        qs = obj.participants.all()
        if request is not None:
            qs = qs.exclude(id=request.user.id)
        # Личный звук входа подмешивается здесь, а не в самом UserSerializer:
        # тот подставляется в КАЖДОЕ сообщение и в каждый reply_to, а звук
        # нужен только там, где следят за составом звонка. Список участников
        # диалога запрашивается редко, лишняя пара коротких строк в нём
        # ничего не весит. Тот же приём, что и у ростера сервера (см.
        # chat.views.ServerMembers).
        return [
            {
                **UserSerializer(user).data,
                "join_sound": user.join_sound,
                "join_sound_url": user.join_sound_url(),
                "leave_sound": user.leave_sound,
                "leave_sound_url": user.leave_sound_url(),
            }
            for user in qs
        ]

    def get_last_message(self, obj):
        cached = self.context.get("last_messages")
        if cached is not None:
            last = cached.get(obj.id)
        else:
            last = obj.messages.order_by("-created_at").first()
        if not last:
            return None
        return {
            "content": last.content,
            "author_id": last.author_id,
            "created_at": last.created_at,
        }

    def get_call_started_at(self, obj):
        # Как и у каналов: если вызывающий сложил состояния в контекст одним
        # пайплайном (см. chat.views.conversation_context), берём оттуда.
        states = self.context.get("call_states")
        room = dm_room(obj.id)
        if states is not None:
            return (states.get(room) or {}).get("call_started_at")
        return presence.call_started_at(room)
