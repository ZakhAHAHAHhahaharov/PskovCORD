from django.conf import settings
from django.db import models

from bugs.models import ErrorGroup, Platform

# Границы полей. Форма — единственное место, куда человек пишет свободный
# текст напрямую в админку, и без потолка сюда прилетит вставленный целиком
# лог на мегабайт.
MAX_DESCRIPTION = 4000
MAX_STEPS = 4000


class ReportStatus(models.TextChoices):
    NEW = "new", "Новое"
    IN_PROGRESS = "in_progress", "В работе"
    ANSWERED = "answered", "Отвечено"
    CLOSED = "closed", "Закрыто"


class BugReport(models.Model):
    """Обращение, написанное человеком руками через форму в правом нижнем
    углу (web/src/components/BugReportModal.tsx).

    Главное здесь — related_groups. Само по себе «у меня не работает» не
    стоит почти ничего: чинить по такому тексту нечего. Но если рядом лежат
    ошибки, которые у этого же человека случились за минуту до отправки, —
    получается готовый тикет со стектрейсом. Поэтому клиент присылает свои
    последние пойманные ошибки, а сервер сводит их с уже известными группами
    (см. support.views.BugReportCreate).
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bug_reports", verbose_name="Пользователь")
    description = models.TextField(verbose_name="Что произошло")
    steps = models.TextField(blank=True, verbose_name="Что к этому привело")
    status = models.CharField(
        max_length=20, choices=ReportStatus.choices, default=ReportStatus.NEW,
        verbose_name="Статус")
    # Заметка для своих — ответ пользователю мы пока никуда не отправляем,
    # но держать разбор рядом с обращением нужно уже сейчас.
    admin_note = models.TextField(blank=True, verbose_name="Заметка (не видна автору)")

    platform = models.CharField(
        max_length=20, choices=Platform.choices, default=Platform.UNKNOWN,
        verbose_name="Платформа")
    route = models.CharField(max_length=500, blank=True, verbose_name="Экран")
    user_agent = models.CharField(max_length=400, blank=True, verbose_name="User-Agent")
    app_version = models.CharField(max_length=60, blank=True, verbose_name="Версия сборки")

    # Только уже известные группы: обращение не должно ЗАВОДИТЬ новую группу
    # ошибок, иначе пересланный в форму чужой текст плодил бы фантомные
    # «ошибки», которых на самом деле ни у кого не случалось.
    related_groups = models.ManyToManyField(
        ErrorGroup, blank=True, related_name="bug_reports",
        verbose_name="Связанные ошибки")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Когда")

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Обращение"
        verbose_name_plural = "Обращения"
        indexes = [
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["-created_at"]),
        ]

    def __str__(self):
        who = self.user.username if self.user else "аноним"
        return f"{who} · {self.created_at:%d.%m %H:%M}"
