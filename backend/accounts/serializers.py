import base64
import binascii

from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()

# Ограничение на декодированный размер аватара — клиент сам сжимает до
# 256x256 JPEG перед отправкой (десятки КБ), это лишь защита от прямых
# запросов в обход клиента (raw base64 бы разросся в БД/трафике рассылки).
MAX_AVATAR_BYTES = 1_500_000
ALLOWED_AVATAR_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "avatar_color", "avatar_image", "status"]


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=4)

    class Meta:
        model = User
        fields = ["id", "username", "password", "avatar_color"]

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Имя пользователя уже занято.")
        return value

    def create(self, validated_data):
        user = User(
            username=validated_data["username"],
            avatar_color=validated_data.get("avatar_color", "#5865F2"),
        )
        user.set_password(validated_data["password"])
        user.save()
        return user


class ProfileUpdateSerializer(serializers.ModelSerializer):
    """PATCH /api/auth/me — смена ника и/или аватара. Оба поля необязательны
    (partial-обновление); avatar_image="" удаляет аватар (возврат к цветному
    кружку с буквой)."""

    class Meta:
        model = User
        fields = ["username", "avatar_image"]
        extra_kwargs = {
            "username": {"required": False},
            "avatar_image": {"required": False, "allow_blank": True},
        }

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exclude(
            pk=self.instance.pk
        ).exists():
            raise serializers.ValidationError("Имя пользователя уже занято.")
        return value

    def validate_avatar_image(self, value):
        if not value:
            return value
        if not value.startswith("data:"):
            raise serializers.ValidationError("Ожидался data-URL картинки.")
        header, _, b64data = value.partition(",")
        mime = header[len("data:"):].split(";")[0]
        if mime not in ALLOWED_AVATAR_MIME:
            raise serializers.ValidationError("Неподдерживаемый формат картинки.")
        try:
            decoded = base64.b64decode(b64data, validate=True)
        except (binascii.Error, ValueError):
            raise serializers.ValidationError("Битые данные аватара.")
        if len(decoded) > MAX_AVATAR_BYTES:
            raise serializers.ValidationError("Аватар слишком большой.")
        return value


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=4)

    def validate_current_password(self, value):
        user = self.context["request"].user
        if not user.check_password(value):
            raise serializers.ValidationError("Неверный текущий пароль.")
        return value
