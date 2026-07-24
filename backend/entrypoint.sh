#!/bin/sh
set -e

# В деве (DJANGO_DEBUG=1, дефолт) runserver сам раздаёт статику из app'ов —
# collectstatic тут не нужен и захламил бы бинд-маунт backend/ на хосте.
# В проде (DEBUG=0) — нужен: собирает статику (в т.ч. admin/css,js) в
# STATIC_ROOT, откуда её напрямую раздаёт nginx на хосте (см.
# docker-compose.prod.yml, deploy/nginx.conf.example).
if [ "${DJANGO_DEBUG:-1}" = "0" ]; then
  echo "[entrypoint] collecting static..."
  python manage.py collectstatic --noinput --clear
fi

echo "[entrypoint] applying migrations..."
python manage.py migrate --noinput

echo "[entrypoint] starting server on :8000 (ASGI via Daphne runserver)..."
exec python manage.py runserver 0.0.0.0:8000
