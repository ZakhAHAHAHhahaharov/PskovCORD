from django.conf import settings
from django.http import FileResponse, Http404, JsonResponse

# Собранный веб-клиент (vite build) — отдаём его как SPA с того же origin.
WEB_DIST = settings.BASE_DIR.parent / "web" / "dist"

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
