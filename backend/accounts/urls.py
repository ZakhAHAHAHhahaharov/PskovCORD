from django.urls import path

from .views import (
    ChangePasswordView,
    LoginView,
    LogoutView,
    MeView,
    NameFontListView,
    QRConfirmView,
    QRScanView,
    QRStartView,
    QRStatusView,
    RegisterView,
    SessionDetailView,
    SessionListView,
    SessionRevokeAllView,
    SessionTokenRefreshView,
    SwitchAccountView,
)

urlpatterns = [
    path("register", RegisterView.as_view(), name="register"),
    path("token", LoginView.as_view(), name="token_obtain_pair"),
    path("token/refresh", SessionTokenRefreshView.as_view(), name="token_refresh"),
    path("switch", SwitchAccountView.as_view(), name="switch-account"),
    path("logout", LogoutView.as_view(), name="logout"),
    path("me", MeView.as_view(), name="me"),
    path("name-fonts", NameFontListView.as_view(), name="name-fonts"),
    path("change-password", ChangePasswordView.as_view(), name="change-password"),
    path("sessions", SessionListView.as_view(), name="sessions"),
    path("sessions/revoke-all", SessionRevokeAllView.as_view(), name="sessions-revoke-all"),
    path("sessions/<int:pk>", SessionDetailView.as_view(), name="session-detail"),
    path("qr/start", QRStartView.as_view(), name="qr-start"),
    path("qr/<str:token>/status", QRStatusView.as_view(), name="qr-status"),
    path("qr/<str:token>/scan", QRScanView.as_view(), name="qr-scan"),
    path("qr/<str:token>/confirm", QRConfirmView.as_view(), name="qr-confirm"),
]
