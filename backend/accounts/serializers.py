import base64
import binascii
import re

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

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


class UserSerializer(serializers.ModelSerializer):
    """Публичный профиль — то, что видят ДРУГИЕ.

    Отсюда убраны banner_image и dm_privacy. banner_image — гифка-баннер
    data-URL'ом до 4 МБ, а этот сериализатор подставляется в КАЖДОЕ сообщение
    (author и reply_to.author) и в каждую строку ростера: баннер уезжал
    десятки раз за один ответ. Сама модель (accounts.models.User) прямо
    говорит, что транслировать его другим не нужно, — REST-путь это правило
    нарушал. Для чужой карточки профиля баннер теперь отдаётся отдельной
    ручкой, ровно когда карточку открыли (chat.views.UserProfileCard).
    dm_privacy — личная настройка приватности, другим её знать незачем.
    """

    class Meta:
        model = User
        fields = [
            "id", "username", "avatar_color", "avatar_image", "status",
            "banner_gradient",
        ]


class MeSerializer(serializers.ModelSerializer):
    """Свой профиль — всё, включая личные настройки и тяжёлый баннер."""

    class Meta:
        model = User
        fields = [
            "id", "username", "avatar_color", "avatar_image", "status",
            "banner_gradient", "banner_image", "dm_privacy",
        ]


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
    """PATCH /api/auth/me — смена ника и/или аватара. Поля необязательны
    (partial-обновление); avatar_image="" удаляет аватар (возврат к цветному
    кружку с буквой).

    current_password — write-only, обязателен, ТОЛЬКО когда меняют username:
    ник виден всем и его смена ничего в аккаунте не защищает сама по себе, но
    это первое, что видит владелец при угоне сессии, — проверка пароля здесь
    ловит момент, когда кто-то с чужим (например, скопированным) access-
    токеном пытается тихо переименовать аккаунт себе."""

    current_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True)

    class Meta:
        model = User
        fields = [
            "username", "avatar_image", "banner_gradient", "banner_image",
            "dm_privacy", "current_password",
        ]
        extra_kwargs = {
            "username": {"required": False},
            "avatar_image": {"required": False, "allow_blank": True},
            "banner_gradient": {"required": False, "allow_blank": True},
            "banner_image": {"required": False, "allow_blank": True},
            "dm_privacy": {"required": False},
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
