from pathlib import Path

from django.db import migrations

SEED_IMAGE = Path(__file__).resolve().parent.parent / "fixtures" / "default_favicon_seed.png"


def seed_default_favicon(apps, schema_editor):
    """Заводит стандартный favicon при первом деплое, если его ещё нет.
    Использует настоящий класс модели (не apps.get_model) — нужен
    Favicon.process() (Pillow-обработка), которого у "замороженной"
    исторической модели миграций нет. Разовый сид с идемпотентным guard'ом
    ниже, так что риск последующего дрейфа полей минимален."""
    from django.contrib.auth import get_user_model

    from core.models import Favicon

    if Favicon.objects.filter(is_default=True).exists():
        return
    User = get_user_model()
    superuser = User.objects.filter(is_superuser=True).order_by("id").first()
    if not superuser or not SEED_IMAGE.exists():
        return
    favicon = Favicon(uploaded_by=superuser, is_default=True)
    with open(SEED_IMAGE, "rb") as f:
        favicon.process(f)
    favicon.save()


class Migration(migrations.Migration):
    dependencies = [("core", "0001_initial")]
    operations = [migrations.RunPython(seed_default_favicon, migrations.RunPython.noop)]
