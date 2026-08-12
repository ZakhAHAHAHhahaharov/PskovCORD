import base64
import binascii
import re

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .avatar_color import compute_avatar_color
from .models import NameFont

User = get_user_model()


def check_password_strength(password, user=None):
    """Прогнать пароль через settings.AUTH_PASSWORD_VALIDATORS.

    Раньше единственным требованием было min_length=4 прямо в поле
    сериализатора, то есть «1234» проходил. Валидаторы Django заодно ловят
    пароли из списка самых распространённых и совпадающие с именем
    пользователя.
    """
    try:
        validate_password(password, user=user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError(list(exc.messages))

# Ограничение на декодированный размер аватара — клиент сам сжимает до
# 256x256 JPEG перед отправкой (десятки КБ), это лишь защита от прямых
# запросов в обход клиента (raw base64 бы разросся в БД/трафике рассылки).
MAX_AVATAR_BYTES = 1_500_000
ALLOWED_AVATAR_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Анимированный аватар (accounts.models.User.avatar_anim) хранится КАК ЕСТЬ:
# перекодировать гифку в браузере нечем (canvas отдаёт один кадр), поэтому
# сжать её, как статику, нельзя — остаётся ограничить вес. Лимит тот же, что
# у баннера: гифка на аватар той же природы и, в отличие от avatar_image, в
# каждом сообщении не едет — только по запросу карточки/наведения.
MAX_AVATAR_ANIM_BYTES = 4_000_000
ALLOWED_AVATAR_ANIM_MIME = {"image/gif"}

# Баннер-гифка крупнее аватара (см. ProfileModal.BANNER_MAX_W/H на фронте —
# 640x320), поэтому лимит выше, но всё ещё ограничен: гифки тяжелее JPEG,
# а хранение — тот же data-URL-в-БД приём, что и для avatar_image.
MAX_BANNER_BYTES = 4_000_000
ALLOWED_BANNER_MIME = {"image/gif", "image/webp", "image/png", "image/jpeg"}

# Ровно то, что собирает фронт (два hex-цвета + угол) — см.
# ProfileModal.buildGradient. Строгий формат вместо свободного CSS: значение
# идёт прямо в style баннера, произвольный текст туда пускать не стоит.
GRADIENT_RE = re.compile(
    r"^linear-gradient\(\d{1,3}deg, #[0-9a-fA-F]{6} 0%, #[0-9a-fA-F]{6} 100%\)$"
)

# Для banner_color/name_color_1/name_color_2 — простой хекс, без альфа-канала
# (в отличие от GRADIENT_RE это не CSS-выражение, а именно значение цвета).
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def validate_hex_color(value):
    """Пусто — сброс к цвету по умолчанию (тема/обычный текст), см. модели
    User.banner_color/name_color_1/name_color_2."""
    if not value:
        return value
    if not HEX_COLOR_RE.match(value):
        raise serializers.ValidationError("Ожидался цвет в формате #RRGGBB.")
    return value


def validate_data_url(value, allowed_mime, max_bytes, what):
    """Разбор и проверка картинки-data-URL: формат → mime → base64 → размер.

    Единственная реализация на проект. Раньше та же логика жила и здесь
    (аватар/баннер профиля), и в chat/serializers.py (значок/баннер сервера) —
    два независимых куска кода, которые нужно было править синхронно руками.
    """
    if not value:
        return value
    if not value.startswith("data:"):
        raise serializers.ValidationError("Ожидался data-URL картинки.")
    header, _, b64data = value.partition(",")
    mime = header[len("data:"):].split(";")[0]
    if mime not in allowed_mime:
        raise serializers.ValidationError("Неподдерживаемый формат картинки.")
    try:
        decoded = base64.b64decode(b64data, validate=True)
    except (binascii.Error, ValueError):
        raise serializers.ValidationError(f"Битые данные ({what}).")
    if len(decoded) > max_bytes:
        raise serializers.ValidationError(f"Слишком большой файл ({what}).")
    return value


class NameFontSerializer(serializers.ModelSerializer):
    """Каталог шрифтов ника — GET /api/auth/name-fonts. Публичный список (не
    привязан к конкретному пользователю), см. accounts.models.NameFont."""

    file = serializers.FileField(use_url=True)

    class Meta:
        model = NameFont
        fields = ["id", "label", "file"]


class UserSerializer(serializers.ModelSerializer):
    """Публичный профиль — то, что видят ДРУГИЕ.

    Отсюда убраны banner_image, banner_color и dm_privacy. banner_image —
    гифка-баннер data-URL'ом до 4 МБ, а этот сериализатор подставляется в
    КАЖДОЕ сообщение (author и reply_to.author) и в каждую строку ростера:
    баннер уезжал десятки раз за один ответ. Сама модель (accounts.models.User)
    прямо говорит, что транслировать его другим не нужно, — REST-путь это
    правило нарушал. Для чужой карточки профиля баннер (и banner_color вместе
    с ним) теперь отдаётся отдельной ручкой, ровно когда карточку открыли
    (chat.views.UserProfileCard). dm_privacy — личная настройка приватности,
    другим её знать незачем.

    name_font/name_effect/name_color_1/name_color_2 — ровно наоборот: их СМЫСЛ
    в том, чтобы другие видели стиль ника в сообщениях/голосовом ростере,
    поэтому они здесь, а не только в MeSerializer (это лёгкие поля — id
    шрифта + пара строк, не гифка)."""

    # avatar_animated — только ФЛАГ, сама гифка (avatar_anim) сюда не едет по
    # той же причине, что и banner_image: этот сериализатор подставляется в
    # каждое сообщение и каждую строку ростера. Клиенту флага достаточно,
    # чтобы знать, есть ли что проигрывать, и догрузить гифку ровно тогда,
    # когда она понадобилась (chat.views.UserAvatarAnimation).
    avatar_animated = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id", "username", "display_name", "avatar_color", "avatar_image",
            "avatar_animated", "avatar_downloadable",
            "status", "banner_gradient",
            "name_font", "name_effect", "name_color_1", "name_color_2", "name_anim_speed",
        ]

    def get_avatar_animated(self, obj) -> bool:
        return bool(obj.avatar_anim)


class MeSerializer(serializers.ModelSerializer):
    """Свой профиль — всё, включая личные настройки и тяжёлый баннер.

    bio — сюда же, а не в отдельную "тяжёлую" ручку как banner_image: это
    просто текст (макс. пара сотен байт), не гифка на мегабайты, раздувать
    им КАЖДОЕ сообщение/строку ростера (см. UserSerializer выше) незачем,
    но и лениво догружать не за чем — в чужой карточке профиля отдаётся
    вместе с баннером через chat.views.UserProfileCard.

    avatar_anim (гифка целиком) и здесь не отдаётся: свой аватар нужен
    редактору ровно в момент, когда его открыли менять, и берётся тем же
    запросом, что и чужой (chat.views.UserAvatarAnimation). Иначе КАЖДЫЙ
    /api/auth/me — а он идёт при каждом старте приложения — вёз бы с собой
    несколько мегабайт base64."""

    avatar_animated = serializers.SerializerMethodField()
    # Метод модели, а не поле таблицы: пусто, пока выбран готовый вариант
    # (см. User.join_sound_url).
    join_sound_url = serializers.ReadOnlyField()
    # Есть ли загруженный файл — независимо от того, выбран он сейчас или нет
    # (см. User.custom_join_sound_url: это разные вопросы).
    custom_join_sound_url = serializers.ReadOnlyField()
    leave_sound_url = serializers.ReadOnlyField()
    custom_leave_sound_url = serializers.ReadOnlyField()

    class Meta:
        model = User
        fields = [
            "id", "username", "display_name", "bio", "pronouns",
            "custom_status", "custom_status_emoji", "date_joined",
            "avatar_color", "avatar_image",
            "avatar_animated", "avatar_frame", "avatar_downloadable",
            "status", "banner_gradient", "banner_image", "banner_color",
            "dm_privacy",
            "name_font", "name_effect", "name_color_1", "name_color_2", "name_anim_speed",
            # Свой звук входа: сам выбор и адрес загруженного файла. В
            # UserSerializer их нет намеренно — он едет в каждое сообщение;
            # другим звук отдаётся вместе с ростером (см. chat.views).
            "join_sound", "join_sound_url", "custom_join_sound_url",
            "leave_sound", "leave_sound_url", "custom_leave_sound_url",
        ]

    def get_avatar_animated(self, obj) -> bool:
        return bool(obj.avatar_anim)


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True)

    class Meta:
        model = User
        fields = ["id", "username", "password", "avatar_color"]

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Имя пользователя уже занято.")
        return value

    def validate(self, attrs):
        # Проверяем в validate(), а не в validate_password(): валидатору
        # похожести нужен username, а он доступен только тут.
        check_password_strength(
            attrs["password"], user=User(username=attrs.get("username", "")))
        return attrs

    def create(self, validated_data):
        user = User(
            username=validated_data["username"],
            avatar_color=validated_data.get("avatar_color", "#5865F2"),
        )
        user.set_password(validated_data["password"])
        user.save()
        return user


class ProfileUpdateSerializer(serializers.ModelSerializer):
    """PATCH /api/auth/me — смена ника, отображаемого имени, био,
    местоимений, статус-текста и/или аватара. Поля необязательны
    (partial-обновление); avatar_image="" удаляет аватар (возврат к
    цветному кружку с буквой), display_name/bio/pronouns/custom_status=""
    — сброс к пустому (тогда карточка показывает только username и без
    облачка статуса).

    username здесь остаётся ради фронтового SettingsModal.UsernameChangeModal
    (единственное место, откуда теперь меняют ник — см. ProfileModal.tsx,
    там username больше не редактируется). current_password — write-only,
    обязателен, ТОЛЬКО когда меняют username: ник виден всем и его смена
    ничего в аккаунте не защищает сама по себе, но это первое, что видит
    владелец при угоне сессии, — проверка пароля здесь ловит момент, когда
    кто-то с чужим (например, скопированным) access-токеном пытается тихо
    переименовать аккаунт себе. display_name/bio такой защиты не требуют —
    это просто подпись и текст "о себе", смена ничего не угоняет."""

    current_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True)

    class Meta:
        model = User
        fields = [
            "username", "display_name", "bio", "pronouns", "custom_status",
            "custom_status_emoji",
            "avatar_image", "avatar_anim", "avatar_frame", "avatar_downloadable",
            "banner_gradient", "banner_image", "banner_color",
            "dm_privacy",
            "name_font", "name_effect", "name_color_1", "name_color_2", "name_anim_speed",
            "current_password",
        ]
        extra_kwargs = {
            "username": {"required": False},
            "display_name": {"required": False, "allow_blank": True},
            "bio": {"required": False, "allow_blank": True},
            "pronouns": {"required": False, "allow_blank": True},
            "custom_status": {"required": False, "allow_blank": True},
            "custom_status_emoji": {"required": False, "allow_blank": True},
            "avatar_image": {"required": False, "allow_blank": True},
            "avatar_anim": {"required": False, "allow_blank": True},
            "avatar_frame": {"required": False},
            "avatar_downloadable": {"required": False},
            "banner_gradient": {"required": False, "allow_blank": True},
            "banner_image": {"required": False, "allow_blank": True},
            "banner_color": {"required": False, "allow_blank": True},
            "dm_privacy": {"required": False},
            "name_font": {"required": False, "allow_null": True},
            "name_effect": {"required": False},
            "name_color_1": {"required": False, "allow_blank": True},
            "name_color_2": {"required": False, "allow_blank": True},
            "name_anim_speed": {"required": False},
        }

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exclude(
            pk=self.instance.pk
        ).exists():
            raise serializers.ValidationError("Имя пользователя уже занято.")
        return value

    def validate(self, attrs):
        if "username" in attrs:
            password = attrs.get("current_password") or ""
            if not password or not self.instance.check_password(password):
                raise serializers.ValidationError(
                    {"current_password": "Неверный текущий пароль."})
        attrs.pop("current_password", None)
        return attrs

    def validate_avatar_image(self, value):
        return validate_data_url(
            value, ALLOWED_AVATAR_MIME, MAX_AVATAR_BYTES, "аватар")

    def validate_avatar_anim(self, value):
        # Только гифка: смысл поля — покадровая анимация, из которой выбран
        # статичный кадр (см. модель). Статике здесь делать нечего, для неё
        # есть avatar_image.
        return validate_data_url(
            value, ALLOWED_AVATAR_ANIM_MIME, MAX_AVATAR_ANIM_BYTES,
            "анимированный аватар")

    # bio — TextField без max_length на самой модели (тот же приём, что и у
    # Server.description в chat.models — свободный текст без БД-лимита),
    # лимит проверяется только здесь, на входе.
    MAX_BIO_LENGTH = 300

    def validate_bio(self, value):
        if len(value) > self.MAX_BIO_LENGTH:
            raise serializers.ValidationError(
                f"Слишком длинное описание (максимум {self.MAX_BIO_LENGTH} символов).")
        return value

    def validate_banner_color(self, value):
        return validate_hex_color(value)

    def validate_name_color_1(self, value):
        return validate_hex_color(value)

    def validate_name_color_2(self, value):
        return validate_hex_color(value)

    # Диапазон синхронизирован со слайдером на фронте (см.
    # DisplayNameStyleModal.tsx) — 0.5x..2.5x, зажимаем, а не отклоняем: сам
    # слайдер физически не даёт выйти за диапазон, значение сюда попадает не
    # с рук набранным JSON'ом, а разве что после его правки в старой вкладке.
    NAME_ANIM_SPEED_MIN = 0.5
    NAME_ANIM_SPEED_MAX = 2.5

    def validate_name_anim_speed(self, value):
        return max(self.NAME_ANIM_SPEED_MIN, min(self.NAME_ANIM_SPEED_MAX, value))

    def update(self, instance, validated_data):
        # Новый аватар — сразу же пересчитываем avatar_color как средний
        # цвет картинки (см. accounts.avatar_color.compute_avatar_color):
        # используется и фоном буквы-заглушки, когда аватара нет, и акцентом
        # тайла участника в голосовом канале, когда есть. avatar_color не
        # выставлен полем на этом сериализаторе намеренно — это не то, что
        # клиент присылает сам, только производное от avatar_image. Аватар
        # УДАЛИЛИ (avatar_image == "") — цвет намеренно не трогаем: он
        # остаётся фоном буквы-заглушки, как и был.
        if validated_data.get("avatar_image"):
            color = compute_avatar_color(validated_data["avatar_image"])
            if color:
                validated_data["avatar_color"] = color
        # Аватар удалили — уносим и гифку: avatar_anim без avatar_image это
        # анимация неизвестно чего, и флаг avatar_animated продолжал бы
        # заставлять клиентов ходить за ней. Смена аватара на обычную
        # картинку — то же самое: анимация относилась к прежней.
        if "avatar_image" in validated_data and "avatar_anim" not in validated_data:
            validated_data["avatar_anim"] = ""
            validated_data["avatar_frame"] = 0
        return super().update(instance, validated_data)

    def validate_banner_gradient(self, value):
        if not value:
            return value
        if not GRADIENT_RE.match(value):
            raise serializers.ValidationError("Некорректный формат градиента.")
        return value

    def validate_banner_image(self, value):
        return validate_data_url(
            value, ALLOWED_BANNER_MIME, MAX_BANNER_BYTES, "баннер")


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True)

    def validate_current_password(self, value):
        user = self.context["request"].user
        if not user.check_password(value):
            raise serializers.ValidationError("Неверный текущий пароль.")
        return value

    def validate_new_password(self, value):
        check_password_strength(value, user=self.context["request"].user)
        return value
