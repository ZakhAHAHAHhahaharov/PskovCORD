from django.core.management.base import BaseCommand

from core.models import Favicon


class Command(BaseCommand):
    """Перегенерирует PNG/ICO-размеры всех favicon-записей из уже
    сохранённого original.png — без повторной загрузки картинок. Нужна
    после смены набора размеров (core.models.PNG_SIZES/ICO_SIZES) или если
    файлы на диске потерялись/повредились."""

    help = "Пересчитать все размеры favicon из сохранённых оригиналов"

    def handle(self, *args, **options):
        favicons = Favicon.objects.all()
        total = favicons.count()
        for i, favicon in enumerate(favicons, start=1):
            favicon.regenerate()
            self.stdout.write(f"[{i}/{total}] {favicon.id} — ок")
        self.stdout.write(self.style.SUCCESS(f"Готово: {total} favicon(ов) пересчитано"))
