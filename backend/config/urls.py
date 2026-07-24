from django.contrib import admin
from django.urls import include, path, re_path

from core.views import healthz, spa

urlpatterns = [
    path("healthz", healthz, name="healthz"),
    # Нестандартный путь — не /admin/, чтобы не светиться на первой же
    # автоматической подборке типовых админ-урлов.
    path("adminpskordpro/", admin.site.urls),
    path("api/auth/", include("accounts.urls")),
    path("api/", include("chat.urls")),
    # Всё остальное — веб-клиент (SPA). Должно идти последним.
    re_path(r"^(?P<path>.*)$", spa, name="spa"),
]
