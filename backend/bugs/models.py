from django.conf import settings
from django.db import models


class Platform(models.TextChoices):
    """Где именно всё сломалось. Присылает клиент, а не выводит сервер из
    User-Agent: у Electron-обёртки (desktop/) UA неотличим от Chrome, а
    будущее мобильное приложение вообще сможет прислать любой. UA всё равно
    сохраняем рядом — как запасной источник, если платформа приехала кривая."""

    WEB_DESKTOP = "web_desktop", "Веб — ПК"
    WEB_MOBILE = "web_mobile", "Веб — мобильный"
    DESKTOP_APP = "desktop_app", "Приложение — ПК"
    MOBILE_APP = "mobile_app", "Приложение — мобильное"
    UNKNOWN = "unknown", "Неизвестно"


class ErrorKind(models.TextChoices):
    """Подкатегория ошибки.

    voice_webrtc и websocket выделены отдельно намеренно: проект голосовой,
    и сбои медиа/шлюза по природе своей другие — они зависят от сети и
    железа человека, а не от нашего кода, и смешивать их с JS-исключениями
    значит потерять ровно ту статистику, ради которой всё затевалось."""

    JS_RUNTIME = "js_runtime", "JS — необработанное исключение"
    RENDER = "render", "React — ошибка рендера"
    PROMISE = "promise", "Promise — необработанный reject"
    API = "api", "API — неуспешный ответ"
    VOICE_WEBRTC = "voice_webrtc", "Голос / WebRTC"
    WEBSOCKET = "websocket", "WebSocket — шлюз"
    MANUAL = "manual", "Отправлено кодом вручную"


class GroupStatus(models.TextChoices):
    NEW = "new", "Новая"
    INVESTIGATING = "investigating", "Разбираемся"
    RESOLVED = "resolved", "Исправлена"
    IGNORED = "ignored", "Игнорируем"


class ErrorGroup(models.Model):
    """Класс одинаковых по сути ошибок, склеенных по подписи (см.
    bugs.fingerprint). Всё, что нужно для «куда развивать приложение»,
    считается по группам, а не по событиям: сотня событий одной группы —
    это одна поломка, а не сто.

    Счётчик times_seen денормализован (растёт при каждом событии), а число
    затронутых людей считается запросом по событиям — оно требует DISTINCT
    и, в отличие от монотонного счётчика, при чистке старых событий
    (см. management/commands/prune_error_events.py) поехало бы.
    """

    fingerprint = models.CharField(max_length=32, unique=True, db_index=True)
    kind = models.CharField(
        max_length=20, choices=ErrorKind.choices, default=ErrorKind.JS_RUNTIME,
        verbose_name="Тип")
    title = models.CharField(max_length=200, verbose_name="Заголовок")
    culprit = models.CharField(
        max_length=200, blank=True, verbose_name="Место",
        help_text="Верхний кадр стека — где именно это произошло.")
    status = models.CharField(
        max_length=20, choices=GroupStatus.choices, default=GroupStatus.NEW,
        verbose_name="Статус")
    times_seen = models.PositiveIntegerField(default=0, verbose_name="Событий")
    first_seen = models.DateTimeField(auto_now_add=True, verbose_name="Впервые")
    last_seen = models.DateTimeField(auto_now=True, verbose_name="Последний раз")
    # Момент, когда группу пометили исправленной. Нужен, чтобы поймать
    # регрессию: событие с датой ПОЗЖЕ этой отметки означает, что починка не
    # сработала (или сломалось снова) — такие группы отдельно подсвечены в
    # сводке, иначе «исправленная» ошибка молча копила бы события дальше.
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name="Исправлена в")

    class Meta:
        ordering = ["-last_seen"]
        verbose_name = "Ошибка (группа)"
        verbose_name_plural = "Ошибки"
        indexes = [
            models.Index(fields=["-last_seen"]),
            models.Index(fields=["status", "-last_seen"]),
        ]

    def __str__(self):
        return f"{self.get_kind_display()}: {self.title}"

    @property
    def is_regressed(self) -> bool:
        return bool(
            self.resolved_at
            and self.status == GroupStatus.RESOLVED
            and self.last_seen > self.resolved_at
        )


class ErrorEvent(models.Model):
    """Одно конкретное попадание — то, что реально прислал клиент.

    Хранится отдельно от группы, потому что вопросы «что это за ошибка» и
    «у кого и при каких обстоятельствах» — разные: первый закрывает группа,
    второй требует именно сырых событий (ник, платформа, роут, версия).
    """

    group = models.ForeignKey(
        ErrorGroup, on_delete=models.CASCADE, related_name="events")
    # null — незалогиненный: ошибки экрана входа и регистрации ловятся тоже,
    # и это как раз те, про которые никто никогда не напишет.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="error_events", verbose_name="Пользователь")
    platform = models.CharField(
        max_length=20, choices=Platform.choices, default=Platform.UNKNOWN,
        verbose_name="Платформа")
    message = models.TextField(verbose_name="Сообщение")
    stack = models.TextField(blank=True, verbose_name="Стек")
    route = models.CharField(max_length=500, blank=True, verbose_name="Экран")
    user_agent = models.CharField(max_length=400, blank=True, verbose_name="User-Agent")
    app_version = models.CharField(max_length=60, blank=True, verbose_name="Версия сборки")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Когда")

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Событие ошибки"
        verbose_name_plural = "События ошибок"
        indexes = [
            models.Index(fields=["-created_at"]),
            models.Index(fields=["group", "-created_at"]),
        ]

    def __str__(self):
        who = self.user.username if self.user else "аноним"
        return f"{who} · {self.created_at:%d.%m %H:%M}"
