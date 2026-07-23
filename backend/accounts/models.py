from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Пользователь PskovCord. Пока = стандартный Django-юзер + цвет аватара."""

    avatar_color = models.CharField(max_length=7, default="#5865F2")

    def __str__(self) -> str:
        return self.username
