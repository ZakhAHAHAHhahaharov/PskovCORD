import os

from django.apps import AppConfig


class ChatConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "chat"

    def ready(self):
        if os.environ.get("DJANGO_SKIP_HEARTBEAT_SWEEP"):
            return
        if not self._should_start_sweeps():
            return
        from . import heartbeat_sweep, vote_sweep

        heartbeat_sweep.start()
        vote_sweep.start()

    @staticmethod
    def _should_start_sweeps() -> bool:
        """Запускать ли фоновые sweep'ы в этом процессе.

        Раньше условием было только RUN_MAIN=='true'. Эту переменную
        выставляет ИСКЛЮЧИТЕЛЬНО автоперезагрузчик runserver — то есть под
        daphne/gunicorn (и под `runserver --noreload`) оба sweep'а молча не
        запускались бы вообще: ни ошибки, ни лога, просто перестают убираться
        призрачные presence-сессии и резолвиться зависшие голосования. Как
        только прод переехал на daphne, это выстрелило бы сразу.
        """
        # Прод и вообще любой ASGI-сервер — явный флаг из entrypoint.sh.
        if os.environ.get("RUN_BACKGROUND_SWEEPS") == "1":
            return True
        # Дев: runserver с автоперезагрузкой вызывает ready() дважды — в
        # родителе-наблюдателе (RUN_MAIN не выставлен) и в рабочем процессе
        # (RUN_MAIN='true'). Заодно отсекает management-команды
        # (migrate/test/shell), которым фоновые потоки не нужны.
        return os.environ.get("RUN_MAIN") == "true"
