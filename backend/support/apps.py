from django.apps import AppConfig


class SupportConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "support"
    # Свой раздел в админке, отдельный от «Bugs». Разделение не косметическое:
    # там — то, что прислала машина (сотни событий, читаются пачками и по
    # графикам), здесь — то, что написал человек и на что нужно ОТВЕТИТЬ.
    # Сваленные в одну кучу, обращения тонут в потоке автоотчётов.
    verbose_name = "Обращения пользователей"
