from rest_framework import serializers

from accounts.serializers import (
    ALLOWED_AVATAR_MIME, ALLOWED_BANNER_MIME, GRADIENT_RE, MAX_BANNER_BYTES,
    UserSerializer, validate_data_url,
)

from . import presence, roles
from .models import (
    Attachment, Channel, Conversation, ConversationMessage,
    ConversationParticipant, Membership,
    Message, Role, Server, ServerBan, ServerEmoji, ServerInvite,
    ServerJoinRequest, dm_room,
)

# Значок сервера жмётся клиентом до 512x512 (ServerSettingsModal.ICON_SIZE) —
# лимит тот же по смыслу, что и у аватара пользователя: защита от запросов
# в обход клиента, а не рабочий предел.
MAX_ICON_BYTES = 1_500_000

# Сколько «особенностей»/правил вообще имеет смысл хранить — не техническое
# ограничение, а защита от бесконечного списка в JSONField.
MAX_TAGS = 12
MAX_TAG_LEN = 32
MAX_RULES = 20


class ChannelSerializer(serializers.ModelSerializer):
    # Длительность текущего разговора и статус — только для голосовых
    # каналов, живут в presence (Redis), пока в канале кто-то есть.
    call_started_at = serializers.SerializerMethodField()
    topic = serializers.SerializerMethodField()
    # Кому открыт приватный канал. Плоским списком id, а не вложенными ролями:
    # сами роли клиент уже держит (api.roles), а тут нужна только связь.
    allowed_role_ids = serializers.SerializerMethodField()

    class Meta:
        model = Channel
        fields = ["id", "server", "name", "kind", "position",
                  "call_started_at", "topic", "status", "slowmode_seconds",
                  "is_private", "allowed_role_ids"]
        read_only_fields = ["server"]

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

    def get_call_started_at(self, obj):
        if obj.kind != Channel.VOICE:
            return None
        return self._state(obj)["call_started_at"]

    def get_topic(self, obj):
        if obj.kind != Channel.VOICE:
            return None
        return self._state(obj)["topic"]


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
            "id", "name", "owner", "created_at", "channels", "icon",
            "banner_gradient", "banner_image", "description", "tags",
            "is_private", "access_mode", "age_restricted", "rules",
            "my_permissions", "my_settings", "member_count",
        ]
        read_only_fields = ["owner", "created_at"]

    def get_channels(self, obj):
        from .permissions import visible_channels

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
                  "width", "height"]

    def get_url(self, obj):
        """Путь относительно корня (`/media/...`), а не абсолютный URL.

        Абсолютный пришлось бы собирать из request.build_absolute_uri, а
        сериализатор работает и без request — тем же объектом сообщение
        рассылается по WebSocket (см. chat.consumers). Домен подставляет
        клиент: тот же base, что у API (см. web/src/api.ts mediaUrl).
        """
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


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    reply_to = MessageReplySerializer(read_only=True)
    attachments = AttachmentSerializer(many=True, read_only=True)
    reactions = serializers.SerializerMethodField()

    # Наружу отдаём именно булев «закреплено» (Message.pinned) — фронту
    # незачем знать, что внутри лежит момент закрепления.
    pinned = serializers.BooleanField(read_only=True)

    class Meta:
        model = Message
        fields = ["id", "channel", "author", "content", "reply_to",
                  "attachments", "reactions", "created_at", "edited_at",
                  "pinned"]
        read_only_fields = ["author", "created_at", "edited_at", "pinned"]

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

    class Meta:
        model = ConversationMessage
        fields = ["id", "conversation", "author", "content", "reply_to",
                  "attachments", "reactions", "server_invite", "created_at",
                  "edited_at"]
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
        return UserSerializer(qs, many=True).data

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
