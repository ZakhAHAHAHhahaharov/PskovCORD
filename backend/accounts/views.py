from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import login as django_login, logout as django_logout
from rest_framework import generics, permissions
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from .serializers import (
    ChangePasswordSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    UserSerializer,
)


def _broadcast_profile_update(user):
    """Живое обновление ника/аватара у остальных — на всех серверах, где
    состоит пользователь (тот же паттерн group_send, что и channel_create/
    voice_state_update в chat.views/consumers). Импорт Membership — внутри
    функции: chat не импортируется на уровне модуля accounts, чтобы не
    создавать лишнюю связь между приложениями при обычной загрузке Django."""
    from chat.models import Membership

    server_ids = Membership.objects.filter(user=user).values_list(
        "server_id", flat=True)
    payload = {
        "op": "profile_update",
        "user_id": user.id,
        "username": user.username,
        "avatar_color": user.avatar_color,
        "avatar_image": user.avatar_image,
    }
    channel_layer = get_channel_layer()
    for server_id in server_ids:
        async_to_sync(channel_layer.group_send)(
            f"server_{server_id}", {"type": "broadcast", "payload": payload})


def tokens_for(user):
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        # Заодно заводим обычную Django-сессию (cookie) — тем же логином,
        # что и в приложении, пускает и в /adminpskordpro/ без отдельного
        # входа (см. LoginView.post — тот же приём).
        django_login(request, user)
        return Response(
            {"user": UserSerializer(user).data, **tokens_for(user)},
            status=201,
        )


class LoginView(TokenObtainPairView):
    """Как стоковый TokenObtainPairView (те же access/refresh в ответе), но
    дополнительно логинит через django.contrib.auth — ставит session-cookie,
    поэтому staff-пользователи сразу попадают в /adminpskordpro/ тем же
    логином/паролем, без отдельного входа в админку."""

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        django_login(request, serializer.user)
        return Response(serializer.validated_data, status=200)


class LogoutView(APIView):
    """Гасит Django-сессию (см. LoginView) при выходе из приложения — иначе
    после логаута в SPA сессия в админке молча жила бы своим сроком."""

    def post(self, request):
        django_logout(request)
        return Response(status=204)


class MeView(APIView):
    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        serializer = ProfileUpdateSerializer(
            request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        _broadcast_profile_update(user)
        return Response(UserSerializer(user).data)


class ChangePasswordView(APIView):
    def post(self, request):
        serializer = ChangePasswordSerializer(
            data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        request.user.set_password(serializer.validated_data["new_password"])
        request.user.save(update_fields=["password"])
        return Response(status=204)
