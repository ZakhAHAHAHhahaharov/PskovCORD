from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path, re_path

from core.views import FAVICON_ROUTES, favicon_file, favicon_manifest, healthz, spa

urlpatterns = [
    path("healthz", healthz, name="healthz"),
    # Нестандартный путь — не /admin/, чтобы не светиться на первой же
    # автоматической подборке типовых админ-урлов.
    path("adminpskordpro/", admin.site.urls),
    path("api/auth/", include("accounts.urls")),
    path("api/", include("bugs.urls")),
    path("api/", include("chat.urls")),
    # Стабильные пути для <link> в web/index.html — реальный файл (чей именно
    # favicon отдать) резолвится per-request в core.views.favicon_file.
    *[
        path(f"api/favicon/{public_name}", favicon_file, {"filename": public_name})
        for public_name in FAVICON_ROUTES
    ],
    path("api/favicon/site.webmanifest", favicon_manifest, name="favicon-manifest"),
]

if settings.DEBUG:
    # Пользовательские загрузки (вложения сообщений, см. chat.models.Attachment).
    # В проде их отдаёт nginx напрямую из volume'а, минуя Django
    # (см. deploy/nginx.conf.example) — здесь только для dev-сервера.
    #
    # ВАЖНО: строго ДО catch-all'а SPA ниже. Раньше эта строка стояла в самом
    # конце файла, после него — и не работала вообще: `^(?P<path>.*)$` матчит
    # в том числе /media/..., Django берёт ПЕРВЫЙ подходящий маршрут, и на
    # запрос картинки приезжал HTML веб-клиента с кодом 200. Незаметно это
    # было ровно потому, что до появления вложений в MEDIA_ROOT лежали одни
    # favicon-наборы, а их отдаёт отдельная вьюха по /api/favicon/.
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

urlpatterns += [
    # Всё остальное — веб-клиент (SPA). Должно идти последним.
    re_path(r"^(?P<path>.*)$", spa, name="spa"),
]
