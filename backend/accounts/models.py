from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Пользователь PskovCord. Пока = стандартный Django-юзер + цвет аватара."""

    ONLINE = "online"
    DND = "dnd"
    INVISIBLE = "invisible"
    STATUS_CHOICES = [
        (ONLINE, "В сети"),
        (DND, "Не беспокоить"),
        (INVISIBLE, "Невидимка"),
    ]

    avatar_color = models.CharField(max_length=7, default="#5865F2")
    # Выбирается самим пользователем; фактическая видимость другим (online/dnd/offline)
    # вычисляется отдельно с учётом реального подключения — см. chat.presence_status.
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=ONLINE)

    def __str__(self) -> str:
        return self.username
