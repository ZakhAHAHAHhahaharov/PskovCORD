from django.contrib.auth import login as django_login, logout as django_logout
from rest_framework import generics, permissions
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from .serializers import RegisterSerializer, UserSerializer


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
