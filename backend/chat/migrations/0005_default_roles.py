from django.db import migrations


def create_default_roles(apps, schema_editor):
    """Роль по умолчанию (аналог @everyone) есть на каждом сервере — новые
    получают её при создании (chat.roles.create_default_role), а серверам,
    заведённым до появления ролей, выдаём её здесь. Без неё у участников без
    персональных ролей не было бы вообще никаких прав (см.
    chat.roles.permissions_for)."""
    Server = apps.get_model("chat", "Server")
    Role = apps.get_model("chat", "Role")
    for server in Server.objects.all():
        if not Role.objects.filter(server=server, is_default=True).exists():
            Role.objects.create(
                server=server, name="Участник", is_default=True, position=0)


def drop_default_roles(apps, schema_editor):
    Role = apps.get_model("chat", "Role")
    Role.objects.filter(is_default=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0004_server_access_mode_server_age_restricted_and_more"),
    ]

    operations = [
        migrations.RunPython(create_default_roles, drop_default_roles),
    ]
