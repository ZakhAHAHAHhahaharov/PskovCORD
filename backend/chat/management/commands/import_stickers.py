"""Залить папку с файлами как базовый набор стикеров.

Базовые наборы (StickerPack.server is None) видны всем и всегда, и завести их
через обычный API нельзя намеренно: он весь построен вокруг «сервер + право на
нём», а у базового набора сервера нет. Отсюда команда — она же единственный
способ добавить их в прод:

    python manage.py import_stickers ./assets/kotiki --pack "Котики"

Имя стикера берётся из имени файла (без расширения) — так набор из папки
получается за один заход, без списка соответствий. Файлы проходят ровно ту же
обработку, что и загруженные через пикер (chat.stickers.prepare): статика
пережимается в WebP, растровая анимация — в анимированный WebP, .json/.tgs
остаются Lottie, .webm берётся как есть.
"""
from pathlib import Path

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError

from chat import stickers as sticker_files
from chat.models import (
    MAX_STICKER_NAME_LEN, MAX_STICKER_PACK_NAME_LEN, MAX_STICKER_SOURCE_BYTES,
    MAX_STICKERS_PER_PACK, Sticker, StickerPack,
)


class Command(BaseCommand):
    help = "Импортировать папку с файлами как базовый набор стикеров."

    def add_arguments(self, parser):
        parser.add_argument("directory", help="Папка с файлами стикеров.")
        parser.add_argument(
            "--pack", required=True,
            help="Название набора — то, что будет подписано на вкладке пикера.")
        parser.add_argument(
            "--order", type=int, default=0,
            help="Порядок среди базовых наборов (меньше — левее).")
        parser.add_argument(
            "--replace", action="store_true",
            help="Очистить набор с таким названием перед импортом.")

    def handle(self, *args, **options):
        directory = Path(options["directory"])
        if not directory.is_dir():
            raise CommandError(f"Папки {directory} нет.")

        pack_name = " ".join(options["pack"].split())[:MAX_STICKER_PACK_NAME_LEN]
        if not pack_name:
            raise CommandError("Пустое название набора.")

        pack, created = StickerPack.objects.get_or_create(
            server=None, name=pack_name,
            defaults={"sort_order": options["order"]})
        if not created and options["replace"]:
            # Через объекты, а не queryset.delete(): файлы с диска убирает
            # сигнал post_delete, и массовое удаление его тоже вызывает, но
            # так очевиднее, что файлы уходят вместе со строками.
            for sticker in pack.stickers.all():
                sticker.delete()

        added, skipped = 0, 0
        for path in sorted(directory.iterdir()):
            if not path.is_file():
                continue
            if pack.stickers.count() >= MAX_STICKERS_PER_PACK:
                self.stderr.write(
                    f"В наборе уже {MAX_STICKERS_PER_PACK} стикеров — "
                    f"остальные файлы пропущены.")
                break
            if path.stat().st_size > MAX_STICKER_SOURCE_BYTES:
                self.stderr.write(f"× {path.name}: файл слишком большой.")
                skipped += 1
                continue
            try:
                prepared = sticker_files.prepare(path.read_bytes())
            except sticker_files.StickerError as err:
                self.stderr.write(f"× {path.name}: {err}")
                skipped += 1
                continue

            name = path.stem.replace("_", " ").strip()[:MAX_STICKER_NAME_LEN]
            sticker = Sticker(
                pack=pack, name=name or path.stem[:MAX_STICKER_NAME_LEN],
                format=prepared.format, animated=prepared.animated,
                content_type=prepared.content_type, size=len(prepared.data),
            )
            extension = "json" if prepared.format == "lottie" else prepared.format
            sticker.file.save(
                f"sticker.{extension}", ContentFile(prepared.data), save=False)
            if prepared.static:
                sticker.static_file.save(
                    "static.webp", ContentFile(prepared.static), save=False)
            sticker.save()
            added += 1
            self.stdout.write(
                f"✓ {path.name} → «{sticker.name}» "
                f"({prepared.format}, {len(prepared.data) // 1024} КБ)")

        self.stdout.write(self.style.SUCCESS(
            f"Набор «{pack.name}»: добавлено {added}, пропущено {skipped}."))
