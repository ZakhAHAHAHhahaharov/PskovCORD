#!/bin/sh
set -e

# В деве (DJANGO_DEBUG=1) runserver сам раздаёт статику из app'ов —
# collectstatic тут не нужен и захламил бы бинд-маунт backend/ на хосте.
# В проде (DEBUG=0, теперь это дефолт) — нужен: собирает статику (в т.ч.
# admin/css,js) в STATIC_ROOT, откуда её напрямую раздаёт nginx на хосте
# (см. docker-compose.prod.yml, deploy/nginx.conf.example).
if [ "${DJANGO_DEBUG:-0}" = "0" ]; then
  echo "[entrypoint] collecting static..."
  python manage.py collectstatic --noinput --clear
fi

echo "[entrypoint] applying migrations..."
python manage.py migrate --noinput

if [ "${DJANGO_DEBUG:-0}" = "0" ]; then
  # Прод — настоящий ASGI-сервер. Раньше здесь безусловно поднимался
  # `manage.py runserver`, то есть дев-сервер Django: с автоперезагрузкой и
  # без какой-либо расчётной прочности под нагрузкой.
  #
  # Фоновые sweep'ы (уборка призрачных presence-сессий и резолв зависших
  # голосований) стартовали по переменной RUN_MAIN, которую выставляет ТОЛЬКО
  # автоперезагрузчик runserver — под daphne они бы молча не запустились
  # вовсе. Поэтому здесь явный флаг; см. chat/apps.py.
  export RUN_BACKGROUND_SWEEPS=1

  # Сколько потоков ASGI отдаёт синхронному коду (обычные вьюхи DRF и
  # database_sync_to_async в консьюмере). asgiref по умолчанию берёт
  # min(32, cpu+4) — а сервер у нас на 1 vCPU (см. DEPLOY.md), то есть по
  # умолчанию это ВСЕГО ПЯТЬ потоков на весь бэкенд: пять одновременных
  # запросов к БД, шестой ждёт. Работа тут почти вся I/O-bound (Postgres,
  # Redis), процессор при этом простаивает, поэтому потолок поднят явно.
  #
  # Выше не задираем: каждый поток с постоянным соединением
  # (DB_CONN_MAX_AGE, см. config/settings.py) держит СВОЁ соединение с
  # Postgres, а у того max_connections по умолчанию 100.
  export ASGI_THREADS="${ASGI_THREADS:-16}"

  echo "[entrypoint] starting daphne (ASGI) on :8000..."
  # --websocket_timeout -1: по умолчанию daphne насильно закрывает ЛЮБОЙ
  # WebSocket через 24 часа. Для чата это разрыв на ровном месте — вкладку
  # держат открытой сутками, и раз в день у неё без причины обрывался
  # realtime. Клиент это переживает (реконнект + добор пропущенного, см.
  # web/src/gateway.tsx), но чинить нечего то, чего не должно происходить.
  #
  # Живость соединения при этом никуда не девается: daphne сам шлёт
  # ping-фреймы протокола раз в 20 секунд и рвёт молчащего клиента через 30
  # (его дефолты --ping-interval/--ping-timeout), а клиент проверяет сервер
  # своим прикладным ping/pong.
  exec daphne -b 0.0.0.0 -p 8000 --websocket_timeout -1 config.asgi:application
fi

# Дев: runserver ради автоперезагрузки и раздачи статики админки. Sweep'ы он
# поднимает сам через RUN_MAIN в рабочем процессе (см. chat/apps.py) — здесь
# RUN_BACKGROUND_SWEEPS намеренно НЕ выставляем, иначе потоки стартовали бы
# дважды: и в наблюдателе, и в рабочем процессе.
echo "[entrypoint] starting runserver (dev) on :8000..."
exec python manage.py runserver 0.0.0.0:8000
