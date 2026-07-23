#!/bin/bash
# Выполняется на сервере GitHub Actions'ом при пуше в main.
set -euo pipefail

cd /opt/pskovcord

echo "[deploy] fetching latest main..."
git fetch origin
git reset --hard origin/main

echo "[deploy] building backend image..."
docker compose -f deploy/docker-compose.prod.yml build backend

echo "[deploy] starting stack..."
docker compose -f deploy/docker-compose.prod.yml up -d

echo "[deploy] applying migrations..."
docker compose -f deploy/docker-compose.prod.yml exec -T backend python manage.py migrate --noinput

echo "[deploy] cleaning up old images..."
docker image prune -f

echo "[deploy] done."
