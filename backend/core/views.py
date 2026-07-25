from django.conf import settings
from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import redirect

from .models import FAVICON_SUBDIR, Favicon

# Собранный веб-клиент (vite build) — отдаём его как SPA с того же origin.
WEB_DIST = settings.BASE_DIR.parent / "web" / "dist"

# Публичное имя файла (в URL) -> реальное имя на диске (см. Favicon.process/
# core.models.PNG_SIZES). apple-touch-icon — общепринятое имя, хотя внутри
# папки иконки лежат просто как "<размер>x<размер>.png".
FAVICON_ROUTES = {
    "favicon.ico": "favicon.ico",
    "icon-16x16.png": "16x16.png",
    "icon-32x32.png": "32x32.png",
    "icon-48x48.png": "48x48.png",
    "apple-touch-icon.png": "180x180.png",
    "icon-192x192.png": "192x192.png",
    "icon-512x512.png": "512x512.png",
}

# Явные MIME-типы: на Windows mimetypes отдаёт .js как text/plain,
# из-за чего браузер отказывается исполнять ES-модули.
CONTENT_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
}


def healthz(_request):
    """Health-check для docker-compose / деплоя."""
    return JsonResponse({"status": "ok", "app": settings.APP_NAME})


def _serve(file_path):
    ctype = CONTENT_TYPES.get(file_path.suffix.lower())
    if ctype:
        return FileResponse(open(file_path, "rb"), content_type=ctype)
    return FileResponse(open(file_path, "rb"))


def _resolve_favicon_id(request):
    """Своя иконка пользователя (если выбрана), иначе стандартная. Сессионная
    кука проверяется AuthenticationMiddleware для ЛЮБОГО запроса (см.
    settings.MIDDLEWARE, не только /admin), так что request.user тут уже
    populated и для обычных <link>-запросов браузера — отдельная
    JWT-авторизация не нужна."""
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated and user.favicon_id:
        return user.favicon_id
    return Favicon.get_default_id()


def favicon_file(request, filename):
    """Редирект на актуальный файл иконки — резолвится per-request, но без
    пересчёта картинки: сами файлы уже сгенерированы заранее один раз при
    загрузке (см. Favicon.process), тут только выбор нужного пути."""
    real_name = FAVICON_ROUTES.get(filename)
    favicon_id = _resolve_favicon_id(request)
    if not real_name or not favicon_id:
        raise Http404
    return redirect(f"{settings.MEDIA_URL}{FAVICON_SUBDIR}/{favicon_id}/{real_name}")


def favicon_manifest(request):
    """site.webmanifest — иконки для Android/PWA (192/512), см. web/index.html."""
    favicon_id = _resolve_favicon_id(request)
    icons = []
    if favicon_id:
        icons = [
            {
                "src": request.build_absolute_uri("/api/favicon/icon-192x192.png"),
                "sizes": "192x192",
                "type": "image/png",
            },
            {
                "src": request.build_absolute_uri("/api/favicon/icon-512x512.png"),
                "sizes": "512x512",
                "type": "image/png",
            },
        ]
    return JsonResponse(
        {"name": settings.APP_NAME, "icons": icons, "display": "standalone"},
        content_type="application/manifest+json",
    )


def spa(_request, path=""):
    """Отдаёт статику из web/dist, иначе index.html (клиентский роутинг)."""
    dist_root = WEB_DIST.resolve()
    if path:
        candidate = (WEB_DIST / path).resolve()
        if str(candidate).startswith(str(dist_root)) and candidate.is_file():
            return _serve(candidate)
    index_file = WEB_DIST / "index.html"
    if index_file.is_file():
        return _serve(index_file)
    raise Http404(
        "web/dist не собран. Выполни: cd web && npm run build"
    )
