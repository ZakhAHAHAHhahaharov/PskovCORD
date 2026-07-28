from django.db import migrations

from accounts.avatar_color import compute_avatar_color


def backfill_avatar_color(apps, schema_editor):
    """avatar_color раньше был только фоном буквы-заглушки без картинки —
    теперь ещё и акцент тайла участника в голосовом канале, когда картинка
    ЕСТЬ (см. accounts.avatar_color.compute_avatar_color), поэтому у всех, у
    кого уже есть avatar_image, пересчитываем его средним цветом их
    картинки. У кого аватара нет — avatar_color не трогаем, он и так
    актуален как фон буквы."""
    User = apps.get_model("accounts", "User")
    for user in User.objects.exclude(avatar_image="").only("id", "avatar_image"):
        color = compute_avatar_color(user.avatar_image)
        if color:
            User.objects.filter(pk=user.pk).update(avatar_color=color)


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0008_qrloginrequest"),
    ]

    operations = [
        migrations.RunPython(backfill_avatar_color, migrations.RunPython.noop),
    ]
