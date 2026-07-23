#!/bin/sh
set -e

echo "[entrypoint] applying migrations..."
python manage.py migrate --noinput

echo "[entrypoint] starting server on :8000 (ASGI via Daphne runserver)..."
exec python manage.py runserver 0.0.0.0:8000
