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

echo "[deploy] building images (backend + sfu)..."
$COMPOSE build

echo "[deploy] starting stack..."
# Миграции применяет entrypoint.sh САМ при старте контейнера — отдельный
# exec migrate здесь раньше был избыточным «на всякий случай» и породил
# реальную гонку: та же самая migrate-команда стартует внутри контейнера
# ОДНОВРЕМЕННО с этим up -d (при пересоздании backend новым образом), и если
# обе успевают дойти до одной непроведённой миграции почти синхронно — вторая
# падает на "duplicate key ... already exists" (см. инцидент 2026-07-24).
# up -d сам дожидается запуска контейнеров, entrypoint.sh мигрирует до того,
# как поднять сервер — повторный вызов здесь не нужен и только вредит.
$COMPOSE up -d

# up -d возвращается сразу после старта процесса в контейнере, не дожидаясь
# entrypoint.sh (migrate + запуск сервера) — даём ему секунду и проверяем,
# что backend реально поднялся, а не упал прямо на migrate (без этой
# проверки такой сбой раньше был бы виден только в exec-migrate, которого
# больше нет — см. комментарий выше).
sleep 3
if [ "$($COMPOSE ps -q backend | xargs docker inspect -f '{{.State.Running}}')" != "true" ]; then
  echo "[deploy] backend не поднялся после up -d — смотри логи:"
  $COMPOSE logs --tail 50 backend
  exit 1
fi

echo "[deploy] cleaning up old images..."
docker image prune -f 2>&1 || true

echo "[deploy] done."
