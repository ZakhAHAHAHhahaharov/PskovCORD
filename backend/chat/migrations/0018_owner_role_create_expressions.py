"""Роль «Владелец» существующих серверов получает право «Создавать средства
выражения эмоций».

Без этой миграции право появилось бы только у серверов, СОЗДАННЫХ после неё:
create_owner_role выдаёт роли владельца все права разом (roles.all_permissions),
а у уже существующих ролей AddField проставил новую колонку в False по
умолчанию. Владелец при этом всегда выше всех в иерархии — вернуть право себе
ему было бы неоткуда, и «+» в пикере эмодзи на его собственном сервере просто
не появился бы.

use_external_emoji чинить не нужно: его AddField добавил со значением True, то
есть все существующие роли уже такие, какими и задумывались.
"""
from django.db import migrations


def grant_to_owner_roles(apps, schema_editor):
    Role = apps.get_model("chat", "Role")
    Role.objects.filter(is_owner_role=True).update(create_expressions=True)


def revoke(apps, schema_editor):
    # Обратно — тоже снимаем: миграция откатывается вместе с самой фичей,
    # и оставлять включённым право, которого больше нет, бессмысленно.
    Role = apps.get_model("chat", "Role")
    Role.objects.filter(is_owner_role=True).update(create_expressions=False)


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0017_role_create_expressions_role_use_external_emoji_and_more"),
    ]

    operations = [
        migrations.RunPython(grant_to_owner_roles, revoke),
    ]
