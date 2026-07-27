"""Канонический ключ пары для личных диалогов + уникальный индекс по нему.

До этого «есть ли уже диалог с этим человеком» проверялось запросом, а потом
создавалось новой строкой — между проверкой и вставкой ничего не мешало
второму такому же запросу (двойной клик, две вкладки) создать второй диалог
между той же парой. Индекс делает это невозможным на уровне БД.

Дубли, уже накопившиеся в проде, не трогаем и не сливаем автоматически:
ключ получает самый старый диалог пары, остальные остаются с пустым ключом и
под условие индекса не попадают. Дальше все новые диалоги ищутся/создаются
по ключу, то есть попадают именно в канонический.
"""
from django.db import migrations, models


def fill_dm_keys(apps, schema_editor):
    Conversation = apps.get_model("chat", "Conversation")
    ConversationParticipant = apps.get_model("chat", "ConversationParticipant")

    seen = set()
    for conversation in Conversation.objects.filter(kind="dm").order_by("id"):
        participant_ids = sorted(
            ConversationParticipant.objects.filter(
                conversation_id=conversation.id
            ).values_list("user_id", flat=True)
        )
        # Ровно два участника — иначе это не диалог, ключ не строим.
        if len(participant_ids) != 2:
            continue
        key = f"{participant_ids[0]}:{participant_ids[1]}"
        if key in seen:
            # Дубль этой пары: оставляем пустой ключ, чтобы не упереться в
            # уникальный индекс. Такой диалог продолжит работать как есть,
            # просто новые запросы будут попадать в канонический.
            continue
        seen.add(key)
        conversation.dm_key = key
        conversation.save(update_fields=["dm_key"])


def clear_dm_keys(apps, schema_editor):
    Conversation = apps.get_model("chat", "Conversation")
    Conversation.objects.filter(kind="dm").update(dm_key="")


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0005_default_roles"),
    ]

    operations = [
        migrations.AddField(
            model_name="conversation",
            name="dm_key",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.RunPython(fill_dm_keys, clear_dm_keys),
        migrations.AddConstraint(
            model_name="conversation",
            constraint=models.UniqueConstraint(
                condition=models.Q(("kind", "dm"), models.Q(("dm_key", ""), _negated=True)),
                fields=("dm_key",),
                name="unique_dm_conversation_pair",
            ),
        ),
    ]
