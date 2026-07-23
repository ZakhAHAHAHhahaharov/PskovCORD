from django.urls import include, path, re_path

from core.views import healthz, spa

urlpatterns = [
    path("healthz", healthz, name="healthz"),
    path("api/auth/", include("accounts.urls")),
    path("api/", include("chat.urls")),
    # Всё остальное — веб-клиент (SPA). Должно идти последним.
    re_path(r"^(?P<path>.*)$", spa, name="spa"),
]
