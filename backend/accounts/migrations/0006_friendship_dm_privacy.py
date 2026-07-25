import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0005_user_favicon'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='dm_privacy',
            field=models.CharField(
                choices=[
                    ('friends', 'Только друзья'),
                    ('nobody', 'Никто'),
                    ('everyone', 'Любой зарегистрированный'),
                ],
                default='everyone',
                max_length=10,
            ),
        ),
        migrations.CreateModel(
            name='Friendship',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('status', models.CharField(
                    choices=[('pending', 'В ожидании'), ('accepted', 'Приняты')],
                    default='pending', max_length=10)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('responded_at', models.DateTimeField(blank=True, null=True)),
                ('from_user', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='sent_friend_requests', to='accounts.user')),
                ('to_user', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='received_friend_requests', to='accounts.user')),
            ],
            options={
                'unique_together': {('from_user', 'to_user')},
            },
        ),
    ]
