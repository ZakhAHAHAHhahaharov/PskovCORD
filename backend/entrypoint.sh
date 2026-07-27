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
  echo "[entrypoint] starting daphne (ASGI) on :8000..."
  exec daphne -b 0.0.0.0 -p 8000 config.asgi:application
fi

# Дев: runserver ради автоперезагрузки и раздачи статики админки. Sweep'ы он
# поднимает сам через RUN_MAIN в рабочем процессе (см. chat/apps.py) — здесь
# RUN_BACKGROUND_SWEEPS намеренно НЕ выставляем, иначе потоки стартовали бы
# дважды: и в наблюдателе, и в рабочем процессе.
echo "[entrypoint] starting runserver (dev) on :8000..."
exec python manage.py runserver 0.0.0.0:8000
