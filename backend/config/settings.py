"""
Django settings для PskovCord.
"""
import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).lower() in ("1", "true", "yes", "on")


# Единственный источник имени приложения.
APP_NAME = os.getenv("APP_NAME", "PskovCord")

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-insecure-change-me")
DEBUG = env_bool("DJANGO_DEBUG", "1")
ALLOWED_HOSTS = [
    h.strip()
    for h in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

INSTALLED_APPS = [
    "daphne",  # раньше staticfiles — включает ASGI-runserver (WebSocket в dev)
    "django.contrib.admin",
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "channels",
    "rest_framework",
    "corsheaders",
    "accounts",
    "chat",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    # Ниже — только для /admin (сессии/CSRF/auth/messages): сам API работает
    # на JWT и от них не зависит, DRF-вьюхи по умолчанию csrf_exempt.
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

AUTH_USER_MODEL = "accounts.User"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("POSTGRES_DB", "pskovcord"),
        "USER": os.getenv("POSTGRES_USER", "pskovcord"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD", "changeme"),
        "HOST": os.getenv("POSTGRES_HOST", "postgres"),
        "PORT": os.getenv("POSTGRES_PORT", "5432"),
    }
}

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(days=1),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
}

# TURN/STUN (coturn, REST shared-secret) — оставлено для совместимости;
# на медиа-леге SFU coturn не участвует (mediasoup сам себе ICE-эндпоинт).
TURN_SECRET = os.getenv("TURN_SECRET", "dev-insecure-turn-secret")
TURN_HOST = os.getenv("TURN_HOST", "localhost")
TURN_PORT = os.getenv("TURN_PORT", "3478")

# SFU (собственный mediasoup Node-сервис) — медиа-транспорт голоса.
# SFU_SECRET — общий секрет для подписи access-токена (см. chat/sfu.py).
# SFU_PUBLIC_URL — WS-URL сигналинга SFU, который отдаём клиенту.
SFU_SECRET = os.getenv("SFU_SECRET", "dev-insecure-sfu-secret")
SFU_PUBLIC_URL = os.getenv("SFU_PUBLIC_URL", "ws://localhost:4443")

# CORS: в dev разрешаем всё (Vite :5173, Electron file://).
CORS_ALLOW_ALL_ORIGINS = DEBUG

# Логин в приложении (LoginView/RegisterView, см. accounts/views.py) заодно
# заводит обычную Django-сессию — тем же браузерным cookie пускает и в
# /adminpskordpro/, без отдельного входа. В проде (DEBUG=0, всегда HTTPS за
# nginx) не даём этим cookie ходить голым по HTTP.
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
# В деве Vite (:5173) и Django (:8000) — разные origin'ы: без этого браузер
# не сохранит cookie сессии, которую ставит LoginView (credentials: 'include'
# на фронте, см. api.ts). В проде всё за одним доменом через nginx — не
# мешает, но и не нужен, там и так same-origin.
CORS_ALLOW_CREDENTIALS = True

STATIC_URL = "static/"
# В деве отдаёт сам runserver (DEBUG=1 — Django-стафайлы обслуживают их
# автоматически). В проде DEBUG=0, поэтому raw-сервер их не раздаёт —
# collectstatic (см. deploy/backend.Dockerfile) складывает сюда, а
# nginx на хосте отдаёт /static/ напрямую из смонтированного volume'а
# (см. deploy/docker-compose.prod.yml, deploy/nginx.conf.example).
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
