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


def _serve(file_path, cache_control=None):
    ctype = CONTENT_TYPES.get(file_path.suffix.lower())
    resp = (
        FileResponse(open(file_path, "rb"), content_type=ctype)
        if ctype
        else FileResponse(open(file_path, "rb"))
    )
    if cache_control:
        resp["Cache-Control"] = cache_control
    return resp


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
    """Отдаёт статику из web/dist, иначе index.html (клиентский роутинг).

    Два момента, из-за которых после нескольких деплоев подряд вкладка,
    открытая (или просто с прогретым кэшем) чуть раньше, показывала белый
    экран без единой ошибки в сети:

    1. index.html без Cache-Control браузер кэшировал эвристически (нет
       Cache-Control — нет и явного запрета). Каждый деплой полностью
       заменяет web/dist новыми хэшами ассетов; кэшированный index.html
       продолжал ссылаться на файлы, которых уже нет на диске.
    2. Запрос такого несуществующего /assets/<старый-хэш>.js не находил
       файл (candidate.is_file() ложь) и проваливался в fallback ниже —
       который отдавал index.html с кодом 200 на ЛЮБОЙ путь, в том числе
       на путь ассета. Браузер получал HTML вместо JS-модуля, пытался его
       исполнить и падал молча — снаружи это выглядело как "сайт умер"
       без единой видимой ошибки (Failed to load module script разве что
       в консоли, куда никто не смотрел).

    Фикс: у путей внутри assets/ нет "запасного" толкования как
    SPA-маршрута — это ВСЕГДА либо конкретный файл, либо настоящий 404
    (пусть браузер сам покажет ошибку загрузки скрипта, а не тихо
    подсовывает HTML). Плюс honest Cache-Control: index.html — no-cache
    (перепроверяется каждый раз), сами хэшированные ассеты — immutable
    (хэш в имени меняется вместе с содержимым, старое имя переиспользовать
    просто нечем).
    """
    dist_root = WEB_DIST.resolve()
    if path:
        candidate = (WEB_DIST / path).resolve()
        if str(candidate).startswith(str(dist_root)) and candidate.is_file():
            cache_control = (
                "public, max-age=31536000, immutable"
                if path.startswith("assets/")
                else "no-cache"
            )
            return _serve(candidate, cache_control)
        if path.startswith("assets/"):
            raise Http404("Ассет не найден — возможно, страница открыта до последнего деплоя.")
    index_file = WEB_DIST / "index.html"
    if index_file.is_file():
        return _serve(index_file, "no-cache")
    raise Http404(
        "web/dist не собран. Выполни: cd web && npm run build"
    )
