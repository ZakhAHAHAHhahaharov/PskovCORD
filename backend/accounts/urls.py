from django.urls import path

from .views import (
    ChangePasswordView,
    LoginView,
    LogoutView,
    MeView,
    RegisterView,
    SessionDetailView,
    SessionListView,
    SessionRevokeAllView,
    SessionTokenRefreshView,
)

urlpatterns = [
    path("register", RegisterView.as_view(), name="register"),
    path("token", LoginView.as_view(), name="token_obtain_pair"),
    path("token/refresh", SessionTokenRefreshView.as_view(), name="token_refresh"),
    path("logout", LogoutView.as_view(), name="logout"),
    path("me", MeView.as_view(), name="me"),
    path("change-password", ChangePasswordView.as_view(), name="change-password"),
    path("sessions", SessionListView.as_view(), name="sessions"),
    path("sessions/revoke-all", SessionRevokeAllView.as_view(), name="sessions-revoke-all"),
    path("sessions/<int:pk>", SessionDetailView.as_view(), name="session-detail"),
]
