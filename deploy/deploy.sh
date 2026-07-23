#!/bin/bash
# Выполняется на сервере GitHub Actions'ом при пуше в main.
set -euo pipefail

cd /opt/pskovcord

# --env-file обязателен: без него docker compose ищет .env рядом с -f файлом
# (deploy/.env), а не в текущей директории.
COMPOSE="docker compose --env-file .env -f deploy/docker-compose.prod.yml"

echo "[deploy] fetching latest main..."
git fetch origin
git reset --hard origin/main

echo "[deploy] building backend image..."
$COMPOSE build backend

echo "[deploy] starting stack..."
$COMPOSE up -d

echo "[deploy] applying migrations..."
$COMPOSE exec -T backend python manage.py migrate --noinput

echo "[deploy] cleaning up old images..."
docker image prune -f 2>&1 || true

echo "[deploy] done."
