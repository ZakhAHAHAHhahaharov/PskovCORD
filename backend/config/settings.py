"""
Django settings для PskovCord.
"""
import os
import sys
from datetime import timedelta
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

# Прогон тестов: часть защит (троттлинг) мешает тестам, часть проверок
# (обязательные секреты) не нужна — см. места использования.
RUNNING_TESTS = "test" in sys.argv


def env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).lower() in ("1", "true", "yes", "on")


# Единственный источник имени приложения.
APP_NAME = os.getenv("APP_NAME", "PskovCord")

# ВАЖНО: дефолт — прод-режим. Раньше здесь было "1", и забытая на сервере
# переменная тихо включала debug-страницы со стектрейсами, CORS с
# credentials для любого origin и cookie без Secure. Локальная разработка
# выставляет DJANGO_DEBUG=1 явно (см. .env.example).
DEBUG = env_bool("DJANGO_DEBUG", "0")

# Значения, которые лежат в .env.example и в compose-файлах — то есть
# публично известны. Годятся только для локальной машины.
_INSECURE_DEFAULTS = {
    "dev-insecure-change-me",
    "dev-insecure-turn-secret",
    "dev-insecure-sfu-secret",
    "changeme",
}


def env_secret(name: str, dev_default: str) -> str:
    """Секрет, который обязан быть настоящим в проде.

    Раньше все секреты имели фолбэк на общеизвестное значение, и приложение
    с пустым окружением молча поднималось полностью небезопасным. Теперь при
    DEBUG=0 отсутствующий или примерный секрет — это отказ старта: сломанный
    деплой заметен сразу, а тихо дырявый — нет.
    """
    value = os.getenv(name, "")
    if not DEBUG and not RUNNING_TESTS and (not value or value in _INSECURE_DEFAULTS):
        raise ImproperlyConfigured(
            f"{name} не задан или равен небезопасному значению по умолчанию. "
            f"Сгенерируйте настоящий: openssl rand -hex 32"
        )
    return value or dev_default


SECRET_KEY = env_secret("DJANGO_SECRET_KEY", "dev-insecure-change-me")
ALLOWED_HOSTS = [
    h.strip()
    for h in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

# В проде nginx термирует TLS и проксирует на backend голым HTTP —
# без этого Django считает КАЖДЫЙ запрос небезопасным (request.is_secure()
# всегда False) и при CSRF-проверке сравнивает реальный браузерный
# "Origin: https://..." со своим самодельным "http://..." — не совпадает,
# и падает CSRF на любом POST (включая логин в саму админку). nginx уже
# шлёт X-Forwarded-Proto (см. nginx.conf.example) — тут просто говорим
# Django ему верить.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
# Тот же класс проблемы, доп. защита: Django по умолчанию доверяет Origin/
# Referer только для ALLOWED_HOSTS по HTTP — с HTTPS-доменом за прокси нужно
# явно перечислить схему.
CSRF_TRUSTED_ORIGINS = [
    f"https://{h}" for h in ALLOWED_HOSTS if h not in ("localhost", "127.0.0.1")
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
    # Отзыв refresh-токенов: без него «выйти» и «сменить пароль» не отзывали
    # ничего — украденный токен продолжал работать весь свой срок.
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "accounts",
    "chat",
    "core",
    "bugs",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    # Без SecurityMiddleware настройки SECURE_* ниже не действуют вообще —
    # `manage.py check --deploy` ругался на это (security.W001).
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    # Ответы уходили без X-Frame-Options, то есть приложение можно было
    # засунуть в чужой iframe (security.W002).
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
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
        "PASSWORD": env_secret("POSTGRES_PASSWORD", "changeme"),
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

# Кэш на Redis, а не LocMem по умолчанию: на нём держатся счётчики троттлинга
# (иначе лимит считался бы отдельно в каждом процессе, то есть множился на их
# число) и кэш стандартного favicon (core.models.Favicon.get_default_id —
# при LocMem процессы расходились в том, какая иконка «стандартная»).
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    }
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    # Раньше троттлинга не было вовсе: подбор пароля к /api/auth/token
    # ограничивался только шириной канала.
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    # За nginx реальный IP приезжает в X-Forwarded-For, и без этой настройки
    # DRF брал ключом троттлинга ВСЮ строку заголовка целиком. nginx дописывает
    # реальный адрес к присланному клиентом ($proxy_add_x_forwarded_for), то
    # есть клиент, подставляя себе произвольный X-Forwarded-For, получал новое
    # ведро на каждый запрос — и лимит "auth" (подбор пароля!) обходился
    # тривиально. С NUM_PROXIES=1 берётся последний адрес в цепочке — тот,
    # что подставил сам nginx; подделать его клиент не может.
    # Значение = число своих прокси перед Django (nginx один, см.
    # deploy/nginx.conf.example). Появится ещё один слой (CDN) — поднять.
    "NUM_PROXIES": 1,
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/min",
        "user": "600/min",
        # Отдельная, куда более жёсткая шкала для логина/регистрации/смены
        # пароля — см. throttle_scope в accounts/views.py.
        "auth": "10/min",
        # Приём отчётов об ошибках (bugs.views.ErrorIngest). Открыт анонимам,
        # поэтому шкала своя: клиент и так глушит повторы у себя, а сюда
        # приходит по одному событию на новую поломку.
        "errors": "30/min",
    },
}

# APITestCase шлёт десятки запросов подряд от одного клиента и упирался бы в
# лимиты. Ставка None (а не отсутствие ключа!) — это штатный для DRF способ
# отключить троттл: сам ключ обязан существовать, иначе throttle падает с
# ImproperlyConfigured ещё на инициализации. Сам троттлинг проверяется
# отдельным тестом с явным override_settings (см. accounts/tests.py).
if RUNNING_TESTS:
    REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"] = {
        scope: None for scope in REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
    }

SIMPLE_JWT = {
    # Был 1 день. Access-токен отозвать нельзя в принципе (он проверяется по
    # подписи, без похода в БД), поэтому его срок — это и есть окно, в течение
    # которого утёкший токен работает после выхода/бана/смены пароля.
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    # Каждое обновление выдаёт новый refresh, а старый уезжает в блэклист:
    # так украденный refresh перестаёт работать, как только настоящий клиент
    # обновится — и наоборот, кража становится заметной.
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
}

AUTH_PASSWORD_VALIDATORS = [
    # Раньше валидаторов не было вообще, а сериализаторы требовали min_length=4:
    # пароль «1234» был полностью законным.
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 8},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# Аватар (до 1.5 МБ) и баннер (до 4 МБ) приходят data-URL'ами в JSON, то есть
# в base64 — это +33% к размеру. Дефолтные ~2.5 МБ Django резали такой запрос
# ещё до сериализатора, из-за чего заявленный лимит баннера был недостижим:
# запрос падал с RequestDataTooBig, а не с внятной ошибкой валидации.
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024

# TURN/STUN (coturn, REST shared-secret) — оставлено для совместимости;
# на медиа-леге SFU coturn не участвует (mediasoup сам себе ICE-эндпоинт).
TURN_SECRET = env_secret("TURN_SECRET", "dev-insecure-turn-secret")
TURN_HOST = os.getenv("TURN_HOST", "localhost")
TURN_PORT = os.getenv("TURN_PORT", "3478")

# SFU (собственный mediasoup Node-сервис) — медиа-транспорт голоса.
# SFU_SECRET — общий секрет для подписи access-токена (см. chat/sfu.py).
# SFU_PUBLIC_URL — WS-URL сигналинга SFU, который отдаём клиенту.
SFU_SECRET = env_secret("SFU_SECRET", "dev-insecure-sfu-secret")
SFU_PUBLIC_URL = os.getenv("SFU_PUBLIC_URL", "ws://localhost:4443")

# CORS: в dev разрешаем всё (Vite :5173, Electron file://).
CORS_ALLOW_ALL_ORIGINS = DEBUG

# Логин в приложении (LoginView/RegisterView, см. accounts/views.py) заодно
# заводит обычную Django-сессию — тем же браузерным cookie пускает и в
# /adminpskordpro/, без отдельного входа. В проде (DEBUG=0, всегда HTTPS за
# nginx) не даём этим cookie ходить голым по HTTP.
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

# Заголовки безопасности (действуют благодаря SecurityMiddleware выше).
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
# HSTS — только в проде и только для самого домена: includeSubDomains/preload
# намеренно не включаем, это решение с необратимыми последствиями для всех
# поддоменов, его принимать осознанно и отдельно.
SECURE_HSTS_SECONDS = 0 if DEBUG else 60 * 60 * 24 * 30
# Редирект http->https оставлен nginx'у (см. deploy/nginx.conf.example): он
# стоит перед Django и разрывает TLS, дублировать это здесь незачем.
SECURE_SSL_REDIRECT = False
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

# Пользовательские загрузки (пока только favicon-наборы, см. core.models.Favicon).
# Ведущий слэш — иначе относительный редирект в core.views.favicon_file
# резолвился бы от текущего пути запроса, а не от корня (как /static/,
# у которого те же грабли есть, но там это не наш код и его не трогаем).
MEDIA_URL = "/media/"
# В деве отдаёт сам runserver (см. config/urls.py, static() добавляется при
# DEBUG=1). В проде — nginx напрямую из смонтированного volume'а, тем же
# приёмом, что и STATIC_ROOT (см. deploy/nginx.conf.example, docker-compose.prod.yml).
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
