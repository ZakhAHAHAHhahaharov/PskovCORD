from django.apps import AppConfig


class BugsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "bugs"
    # Заголовок раздела в админке. Отдельное приложение (а не пара моделей в
    # core) заведено ровно ради него: индекс админки группирует модели по
    # приложению, и это единственный способ получить свой раздел «Bugs»
    # рядом с остальными, не переписывая шаблон индекса.
    verbose_name = "Bugs"
