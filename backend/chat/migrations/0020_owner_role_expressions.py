"""Роль «Владелец» существующих серверов получает права на средства выражения
эмоций.

create_expressions и manage_expressions завели заранее, под ещё не написанную
фичу (см. 0017 и бывший chat.roles.UPCOMING_PERMISSIONS), с default=False —
и пока они были «скоро», это никого не задевало. Теперь кастомные эмодзи
появились, права стали настоящими, и разница вылезла: create_owner_role выдаёт
роли владельца все права разом (roles.all_permissions), но у ролей, СОЗДАННЫХ
РАНЬШЕ, обе колонки так и остались False. Владелец при этом всегда выше всех в
иерархии — вернуть право себе ему было бы неоткуда, и на собственном сервере
он не смог бы ни добавить эмодзи, ни удалить чужой.

use_external_emojis чинить не нужно: его AddField добавил со значением True,
то есть все существующие роли уже такие, какими и задумывались.
"""
from django.db import migrations

EXPRESSION_PERMISSIONS = {
    "create_expressions": True,
    "manage_expressions": True,
}


def grant_to_owner_roles(apps, schema_editor):
    Role = apps.get_model("chat", "Role")
    Role.objects.filter(is_owner_role=True).update(**EXPRESSION_PERMISSIONS)


def revoke(apps, schema_editor):
    # Обратно — тоже снимаем: миграция откатывается вместе с самой фичей,
    # и оставлять включённым право, которого больше нет, бессмысленно.
    Role = apps.get_model("chat", "Role")
    Role.objects.filter(is_owner_role=True).update(
        **{name: False for name in EXPRESSION_PERMISSIONS})


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0019_serveremoji_serveremoji_unique_server_emoji_name"),
    ]

    operations = [
        migrations.RunPython(grant_to_owner_roles, revoke),
    ]
