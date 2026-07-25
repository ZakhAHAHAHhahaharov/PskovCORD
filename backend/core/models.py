import shutil
import uuid
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver
from PIL import Image, ImageOps

FAVICON_SUBDIR = "favicons"

# Верхняя граница мастер-изображения — крупнее не нужно ни одному из
# генерируемых размеров (см. PNG_SIZES), поэтому именно до неё (не больше)
# сжимается загрузка перед сохранением на диск.
MASTER_SIZE = 512
# 16/32 — классический favicon, 48 — для .ico (винда), 180 — apple-touch-icon,
# 192/512 — android/PWA-манифест (core.views.favicon_manifest).
PNG_SIZES = (16, 32, 48, 180, 192, 512)
ICO_SIZES = (16, 32, 48)

DEFAULT_FAVICON_CACHE_KEY = "core:favicon:default_id"
_UNSET = object()


class Favicon(models.Model):
    """Набор иконок сайта. Загруженная картинка при process() обрезается до
    квадрата и сжимается до MASTER_SIZE — из неё заранее (не на каждый HTTP-
    запрос) генерируются все нужные браузеру/Django размеры (PNG_SIZES/
    ICO_SIZES). Файлы лежат на диске в MEDIA_ROOT/favicons/<id>/ и
    раздаются как обычная статика (core.views.favicon_file) — без
    пересчёта на каждый запрос."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="uploaded_favicons",
        verbose_name="Загрузил",
    )
    # Мастер-изображение (уже обрезанное и сжатое, см. process()). editable=False —
    # в админку загрузка идёт через отдельное несвязанное с моделью поле формы
    # (FaviconAdminForm.upload), т.к. сырой файл нужно сперва обработать Pillow'ом,
    # а не сохранить как есть — стандартный автосейв ImageField тут не подходит.
    original = models.ImageField(upload_to=FAVICON_SUBDIR, editable=False)
    # Ровно одна на систему — та, что видят все, у кого нет своей выбранной
    # (accounts.User.favicon is None). Ставить может только суперюзер
    # (см. clean()); единственность обеспечивается save() (снимает флаг со
    # всех остальных в той же транзакции) + частичным unique-индексом в БД
    # как защита от гонки/обхода save() (например через queryset.update()).
    is_default = models.BooleanField(default=False, verbose_name="Стандартная")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Загружена")

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Favicon"
        verbose_name_plural = "Favicons"
        constraints = [
            models.UniqueConstraint(
                fields=["is_default"],
                condition=models.Q(is_default=True),
                name="unique_default_favicon",
            )
        ]

    def __str__(self):
        return f"{self.id} ({self.uploaded_by})"

    @property
    def directory(self) -> Path:
        return Path(settings.MEDIA_ROOT) / FAVICON_SUBDIR / str(self.id)

    def clean(self):
        if self.is_default and self.uploaded_by_id and not self.uploaded_by.is_superuser:
            raise ValidationError(
                {"is_default": "Стандартной может быть только иконка, загруженная суперпользователем."}
            )

    def save(self, *args, **kwargs):
        self.clean()
        with transaction.atomic():
            if self.is_default:
                Favicon.objects.exclude(pk=self.pk).filter(is_default=True).update(is_default=False)
            super().save(*args, **kwargs)
        cache.delete(DEFAULT_FAVICON_CACHE_KEY)

    def process(self, uploaded_file) -> None:
        """(Пере)генерирует мастер-изображение и все размеры из uploaded_file —
        сырого загруженного файла (UploadedFile) либо любого file-like с
        поддержкой read()/seek(). Ничего не сохраняет в БД — вызывающий
        сам должен вызвать save() после."""
        img = Image.open(uploaded_file)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGBA")

        w, h = img.size
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        img = img.crop((left, top, left + side, top + side))
        if side > MASTER_SIZE:
            img = img.resize((MASTER_SIZE, MASTER_SIZE), Image.LANCZOS)

        directory = self.directory
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)

        self._save_png(directory / "original.png", img)
        # Не через FieldFile.save() — файл уже физически записан выше;
        # editable=False держит _committed=True, так что Django на save()
        # модели не попытается перезаписать его сырым апломдом (см. docstring поля).
        self.original.name = f"{FAVICON_SUBDIR}/{self.id}/original.png"

        for size in PNG_SIZES:
            resized = img if img.size == (size, size) else img.resize((size, size), Image.LANCZOS)
            self._save_png(directory / f"{size}x{size}.png", resized)

        img.save(directory / "favicon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])

    def regenerate(self) -> None:
        """Перегенерирует все размеры из уже сохранённого original.png — для
        смены набора размеров задним числом, без повторной загрузки (см.
        management-команду regenerate_favicons)."""
        with self.original.open("rb") as f:
            self.process(f)

    @staticmethod
    def _save_png(path: Path, img: Image.Image) -> None:
        img.save(path, format="PNG", optimize=True)

    @classmethod
    def get_default_id(cls):
        cached = cache.get(DEFAULT_FAVICON_CACHE_KEY, _UNSET)
        if cached is not _UNSET:
            return cached or None
        favicon_id = cls.objects.filter(is_default=True).values_list("id", flat=True).first()
        cache.set(DEFAULT_FAVICON_CACHE_KEY, favicon_id, timeout=None)
        return favicon_id


@receiver(post_delete, sender=Favicon)
def _cleanup_favicon_files(sender, instance, **kwargs):
    """Сигнал, а не override Favicon.delete() — так отрабатывает и для
    queryset.delete() (админский bulk-action "Удалить выбранные"), который
    override delete() модели обошёл бы стороной."""
    shutil.rmtree(instance.directory, ignore_errors=True)
    cache.delete(DEFAULT_FAVICON_CACHE_KEY)
