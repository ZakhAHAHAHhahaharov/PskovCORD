import os

from django.apps import AppConfig


class ChatConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "chat"

    def ready(self):
        # runserver (используется и в dev, и в проде — см. entrypoint.sh) по
        # умолчанию запускается с автоперезагрузкой: ready() вызывается и в
        # родителе-наблюдателе (RUN_MAIN не выставлен), и в дочернем процессе,
        # который реально обслуживает запросы (RUN_MAIN='true'). Management-
        # команды (migrate/test/shell и т.п.) RUN_MAIN тоже не выставляют —
        # им фоновый sweep не нужен. Так что «запускать только при
        # RUN_MAIN=='true'» разом решает обе задачи: не дублировать поток и
        # не тащить его в служебные команды.
        if os.environ.get("DJANGO_SKIP_HEARTBEAT_SWEEP"):
            return
        if os.environ.get("RUN_MAIN") != "true":
            return
        from . import heartbeat_sweep

        heartbeat_sweep.start()
