from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "avatar_color", "status"]


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
