"""Автор каждой уже существующей ветки становится её участником.

С появлением ThreadMember сайдбар показывает только СВОИ ветки (см.
chat.models.ThreadMember). Ветки, заведённые до этого, участников не имеют
вовсе — и после выката разом пропали бы у всех из списка каналов, хотя ничего
с ними не случилось. Достать их можно было бы через «Показать все ветки», но
выглядело бы это как потеря данных.

Автор — единственное, что о причастности к старой ветке известно наверняка.
Восстанавливать по «кто в ней писал» тоже можно, но это уже догадка: человек
мог написать одну реплику год назад и не иметь ни малейшего желания видеть
эту ветку в сайдбаре сегодня.
"""
from django.db import migrations


def add_authors(apps, schema_editor):
    Channel = apps.get_model("chat", "Channel")
    ThreadMember = apps.get_model("chat", "ThreadMember")
    rows = [
        ThreadMember(thread_id=thread.id, user_id=thread.created_by_id)
        for thread in Channel.objects.filter(
            kind="thread", created_by__isnull=False)
    ]
    # ignore_conflicts: миграцию могли прогнать на базе, где участие уже
    # проставлено (перезапуск, ручная правка) — повторный проход не должен
    # падать на уникальном ограничении.
    ThreadMember.objects.bulk_create(rows, ignore_conflicts=True)


def noop(apps, schema_editor):
    """Откат ничего не удаляет: к моменту отката участие могло появиться и
    по-настоящему (кто-то написал в ветку), и отличить его от проставленного
    здесь уже нельзя."""


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0028_channel_invite_only_channel_locked_and_more"),
    ]

    operations = [
        migrations.RunPython(add_authors, noop),
    ]
