from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from bugs.models import ErrorEvent, ErrorGroup

DEFAULT_KEEP_DAYS = 90


class Command(BaseCommand):
    """Чистка старых СОБЫТИЙ с сохранением групп.

    Поток отчётов растёт неограниченно и без чистки однажды займёт больше
    места, чем сама переписка. Удаляются при этом только события: группа —
    это несколько сотен байт, в ней лежит история (когда впервые, сколько
    всего, статус), и терять её вместе с событиями значит терять ровно ту
    длинную картину, ради которой группировка и заведена.

    Счётчик times_seen намеренно НЕ пересчитывается: он про «сколько раз
    это вообще случалось за всё время», а не «сколько событий сейчас лежит
    в базе» — пересчёт после чистки превратил бы его во второе.
    """

    help = "Удаляет события ошибок старше N дней, оставляя сами группы."

    def add_arguments(self, parser):
        parser.add_argument(
            "--days", type=int, default=DEFAULT_KEEP_DAYS,
            help=f"Сколько дней хранить (по умолчанию {DEFAULT_KEEP_DAYS}).")
        parser.add_argument(
            "--drop-empty-groups", action="store_true",
            help="Заодно удалить группы, у которых не осталось ни одного "
                 "события и которые помечены «Исправлена» или «Игнорируем».")

    def handle(self, *args, **options):
        days = options["days"]
        if days < 1:
            self.stderr.write("--days должен быть >= 1.")
            return
        cutoff = timezone.now() - timedelta(days=days)

        deleted, _ = ErrorEvent.objects.filter(created_at__lt=cutoff).delete()
        self.stdout.write(f"Удалено событий: {deleted} (старше {days} дн.).")

        if options["drop_empty_groups"]:
            stale = ErrorGroup.objects.filter(
                events__isnull=True, status__in=("resolved", "ignored"))
            count = stale.count()
            stale.delete()
            self.stdout.write(f"Удалено пустых закрытых групп: {count}.")
