# PskovCord — продакшн-деплой

## Инфраструктура

| Что | Значение |
|-----|----------|
| Сервер | Ubuntu 26.04, 1 vCPU / 4GB RAM, IP `94.26.90.101` |
| Домен | https://pskord.zlgvpn.org (Let's Encrypt, автопродление certbot) |
| Путь на сервере | `/opt/pskovcord` (git-репозиторий, ветка `main`) |
| Пользователь деплоя | `deploy` (группа `docker`, вход только по SSH-ключу) |
| Голос | LiveKit Cloud (не self-hosted — не требует TURN/UDP-проброса) |

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
  `DJANGO_ALLOWED_HOSTS=pskord.zlgvpn.org`, ключи LiveKit Cloud.

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

## Продление сертификата

Настроено автоматически (`certbot` systemd timer). Проверить:

```bash
ssh deploy@94.26.90.101 "sudo certbot renew --dry-run"
```
