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
    # data-URL (data:image/jpeg;base64,...) — хранится прямо в БД, без
    # ImageField/MEDIA_ROOT/Pillow: аватарки маленькие (сжимаются клиентом до
    # 256x256 перед отправкой), а лишний медиа-сервинг (volume + nginx
    # location, как для static/) для дружеского масштаба избыточен. Пусто —
    # аватара нет, показывается цветной кружок с буквой (avatar_color).
    avatar_image = models.TextField(blank=True, default="")
    # Фон карточки профиля (всплывает над status-menu). Пусто — стандартный
    # градиент по умолчанию (см. фронт). Ровно один из двух источников
    # активен: либо CSS-градиент, либо гифка (banner_image побеждает, если
    # оба почему-то заполнены — так решает фронт при отрисовке).
    banner_gradient = models.CharField(max_length=120, blank=True, default="")
    # data-URL (data:image/gif;base64,...), как avatar_image — та же логика
    # хранения. Не транслируется другим участникам через profile_update
    # (см. accounts.views._broadcast_profile_update): пока используется
    # только в собственной карточке профиля, незачем гонять гифки по WS
    # всем на сервере.
    banner_image = models.TextField(blank=True, default="")
    # Выбирается самим пользователем; фактическая видимость другим (online/dnd/offline)
    # вычисляется отдельно с учётом реального подключения — см. chat.presence_status.
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=ONLINE)

    def __str__(self) -> str:
        return self.username
