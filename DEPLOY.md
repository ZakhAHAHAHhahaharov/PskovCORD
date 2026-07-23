# PskovCord — продакшн-деплой

## Инфраструктура

| Что | Значение |
|-----|----------|
| Сервер | Ubuntu 26.04, 1 vCPU / 4GB RAM, IP `94.26.90.101` |
| Домен | https://pskord.zlgvpn.org (TLS — общий wildcard `*.zlgvpn.org`) |
| Путь на сервере | `/opt/pskovcord` (git-репозиторий, ветка `main`) |
| Пользователь деплоя | `deploy` (группа `docker`, вход только по SSH-ключу) |
| Голос | Свой WebRTC P2P mesh + coturn (self-hosted STUN/TURN, UDP 3478 + 49160-49200) |

## Архитектура

```
Интернет → nginx (хост, TLS-терминация, :80→:443) → backend (Docker, 127.0.0.1:8000)
                                                         ├─ postgres (Docker, без публичного порта)
                                                         └─ redis    (Docker, без публичного порта)
```

- `backend` — один Docker-образ (`deploy/backend.Dockerfile`, multi-stage): собирает
  `web/` (Vite) и кладёт `web/dist` рядом с backend, который сам отдаёт SPA
  (`core.views.spa`) — single-origin, как и в локальной разработке.
- nginx стоит на хосте (не в контейнере) — проще управлять сертификатом и не
  тратить лишние ресурсы контейнера на 1 vCPU машине.
- Postgres/Redis доступны только из docker-сети — портов наружу нет.
- `coturn` (STUN/TURN) работает в `network_mode: host` — слушает 3478/udp+tcp
  и relay-диапазон 49160-49200/udp напрямую на публичном IP сервера, мимо nginx
  и docker NAT. Голосовой сигналинг (SDP/ICE) идёт через тот же `/ws/gateway`,
  что и остальной realtime — отдельный location в nginx не нужен. Сам аудиопоток
  в mesh-схеме идёт напрямую между браузерами клиентов (через coturn как relay
  только когда прямой P2P невозможен из-за NAT).

## CI/CD

- **`.github/workflows/ci.yml`** — на каждый PR в `main`/`dev`: typecheck+build веб-клиента,
  `manage.py check`+`migrate` бэкенда на чистой Postgres/Redis. Обязательные проверки
  для мержа в `main`.
- **`.github/workflows/deploy.yml`** — на пуш в `main` (то есть на мерж PR):
  подключается по SSH и выполняет `deploy/deploy.sh` на сервере:
  `git reset --hard origin/main` → `docker compose build backend` → `up -d` → `migrate`.

Ветка `main` защищена (branch protection): только через PR, обязательные CI-чеки,
запрещены force-push и удаление ветки, действует и для админов. Рабочая ветка для
разработки — `dev`; фичи мержатся в `dev`/через PR в `main` по готовности.

## Секреты

- **GitHub Actions secrets** (репозиторий → Settings → Secrets): `SSH_HOST`, `SSH_USER`,
  `SSH_PORT`, `SSH_KEY` (приватный ключ деплоя, публичный — в
  `/home/deploy/.ssh/authorized_keys` на сервере).
- **`/opt/pskovcord/.env`** и **`/opt/pskovcord/backend/.env`** на сервере (права 600,
  не в git) — Postgres-пароль, `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`,
  `DJANGO_ALLOWED_HOSTS=pskord.zlgvpn.org`, `TURN_SECRET` (одинаковый в обоих
  файлах — coturn читает его через compose-подстановку из корневого `.env`,
  Django — из `backend/.env`; сгенерировать `openssl rand -hex 32`).

**Firewall на сервере** (вручную, не через docker — `coturn` в `network_mode: host`):
открыть `3478/udp`, `3478/tcp`, `49160-49200/udp`.

## Ручные операции на сервере

```bash
ssh deploy@94.26.90.101   # ключ deploy_key, не пароль root

cd /opt/pskovcord
docker compose --env-file .env -f deploy/docker-compose.prod.yml ps
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f backend
```

Ручной передеплой (обычно не нужен — делает GitHub Actions):

```bash
bash /opt/pskovcord/deploy/deploy.sh
```

## TLS-сертификат

Используется **общий wildcard-сертификат `*.zlgvpn.org`**, лежит на сервере в
`/etc/letsencrypt/live/zlgvpn.org/` и покрывает все поддомены `zlgvpn.org`, не только
`pskord`. Выпускается/продлевается **централизованно, не через certbot этого сервера**
(wildcard требует DNS-01 challenge, а не HTTP-01, который умеет certbot-nginx плагин) —
`certbot certificates` на этом сервере его не увидит и продлевать не будет. Обновление
сертификата — вне зоны ответственности этого репозитория; если истечёт, nginx нужно
просто перечитать конфиг (`systemctl reload nginx`) после обновления файлов в
`/etc/letsencrypt/live/zlgvpn.org/`.

nginx-конфиг: `/etc/nginx/sites-available/pskovcord` (референс — `deploy/nginx.conf.example`).
