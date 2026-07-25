from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0003_user_avatar_image'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='banner_gradient',
            field=models.CharField(blank=True, default='', max_length=120),
        ),
        migrations.AddField(
            model_name='user',
            name='banner_image',
            field=models.TextField(blank=True, default=''),
        ),
    ]
