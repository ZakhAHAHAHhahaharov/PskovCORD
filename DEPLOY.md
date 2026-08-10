# PskovCord — продакшн-деплой

## Инфраструктура

| Что | Значение |
|-----|----------|
| Сервер | Ubuntu 26.04, 1 vCPU / 4GB RAM, IP `<SERVER_IP>` |
| Домен | https://pskord.zlgvpn.org (TLS — общий wildcard `*.zlgvpn.org`) |
| Путь на сервере | `/opt/pskovcord` (git-репозиторий, ветка `main`) |
| Пользователь деплоя | `deploy` (группа `docker`, вход только по SSH-ключу) |
| Голос | Свой **SFU на mediasoup** (сервис `sfu`): сигналинг через nginx `wss://…/sfu`, медиа — UDP/TCP `40000-40100` напрямую |

## Архитектура

```
Интернет → nginx (хост, TLS-терминация, :80→:443) ─┬→ backend (Docker, 127.0.0.1:8000)
                                                   │      ├─ postgres (Docker, без публичного порта)
                                                   │      └─ redis    (Docker, без публичного порта)
                                                   └→ /sfu → sfu (host-сеть, 127.0.0.1:4443) — сигналинг

Медиа голоса (аудио + демонстрация экрана): браузер ⇄ sfu напрямую,
UDP/TCP 40000-40100 на публичном IP, мимо nginx и docker NAT.
```

- `backend` — один Docker-образ (`deploy/backend.Dockerfile`, multi-stage): собирает
  `web/` (Vite) и кладёт `web/dist` рядом с backend, который сам отдаёт SPA
  (`core.views.spa`) — single-origin, как и в локальной разработке.
- nginx стоит на хосте (не в контейнере) — проще управлять сертификатом и не
  тратить лишние ресурсы контейнера на 1 vCPU машине.
- Postgres/Redis доступны только из docker-сети — портов наружу нет.
- `sfu` (mediasoup) работает в `network_mode: host`: сигналинг слушает
  `127.0.0.1:4443` (наружу порт **не открывается** — его проксирует nginx по
  `wss://pskord.zlgvpn.org/sfu`, поэтому нет mixed content на HTTPS-странице),
  а медиа принимает напрямую на публичном IP в диапазоне `40000-40100/udp+tcp`.
  mediasoup — сам себе ICE-эндпоинт, поэтому **coturn для голоса больше не нужен**
  (оставлен в стеке как легаси; можно удалить отдельным изменением, чтобы
  освободить ресурсы 1 vCPU).
- Django только выдаёт короткоживущий `sfu_token` (общий секрет `SFU_SECRET`) —
  через обычный REST; presence/кто-в-канале/мьют по-прежнему идут через `/ws/gateway`.

### Устойчивость соединения

Backend — **один процесс daphne**, и это осознанно: машина на 1 vCPU, второй
процесс на ней ничего не ускорит. Отсюда следствия и ручки:

- `ASGI_THREADS` (по умолчанию 16, ставится в `entrypoint.sh`) — потолок
  одновременных синхронных операций. Дефолт asgiref на 1 vCPU дал бы всего 5.
- `DB_CONN_MAX_AGE` (по умолчанию 60) — постоянные соединения с Postgres.
  Связан с предыдущим: живых соединений ≈ число потоков, а `max_connections`
  у Postgres — 100. Поднимая одно, проверь другое.
- `healthcheck` на `/healthz` — единственный процесс может остаться живым с
  мёртвым event loop'ом; без проверки `restart: unless-stopped` этого не видит.
- `stop_grace_period: 30s` — чтобы при деплое daphne успел закрыть сокеты
  штатным close-фреймом. Тогда клиент переподключается сразу, а не через
  watchdog (см. `web/src/gateway.tsx`).
- Деплой = разрыв realtime у всех разом. Клиент это переживает сам:
  экспоненциальный backoff с джиттером, а после реконнекта — добор
  пропущенных сообщений по `after=<последний id>` (см. `useGatewayEvents`).

## CI/CD

- **`.github/workflows/ci.yml`** — на каждый PR в `main`/`dev`: typecheck+build веб-клиента,
  `manage.py check`+`migrate` бэкенда на чистой Postgres/Redis. Обязательные проверки
  для мержа в `main`.
- **`.github/workflows/deploy.yml`** — на пуш в `main` (то есть на мерж PR):
  подключается по SSH и выполняет `deploy/deploy.sh` на сервере:
  `git reset --hard origin/main` → `docker compose build` (backend + sfu) →
  `up -d` → `migrate`.

Ветка `main` защищена (branch protection): только через PR, обязательные CI-чеки,
запрещены force-push и удаление ветки, действует и для админов. Рабочая ветка для
разработки — `dev`; фичи мержатся в `dev`/через PR в `main` по готовности.

## Секреты

- **GitHub Actions secrets** (репозиторий → Settings → Secrets): `SSH_HOST`, `SSH_USER`,
  `SSH_PORT`, `SSH_KEY` (приватный ключ деплоя, публичный — в
  `/home/deploy/.ssh/authorized_keys` на сервере).
- **`/opt/pskovcord/backend/.env`** (права 600, не в git) — Postgres-пароль,
  `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`, `DJANGO_ALLOWED_HOSTS=pskord.zlgvpn.org`.
- **`/opt/pskovcord/.env`** (корневой, права 600, не в git) — `POSTGRES_*` для
  compose плюс **оба общих секрета: `SFU_SECRET` и `TURN_SECRET`**.

> **Обязательно, иначе деплой не поднимется.** Раньше отсутствующие секреты
> молча подменялись дефолтами из `.env.example` — то есть прод мог работать на
> общеизвестном `dev-insecure-sfu-secret`, и кто угодно мог подписать себе
> токен в любую голосовую комнату. Теперь и `docker compose`
> (`${SFU_SECRET:?...}`), и сам Django (`config/settings.py`, `env_secret`), и
> SFU (`sfu/src/config.ts`) при `DEBUG=0` отказываются стартовать без
> настоящих значений. Это осознанно: сломанный деплой виден сразу, тихо
> дырявый — нет.

Проверить перед первым деплоем новой версии:

```bash
cd /opt/pskovcord
grep -E '^(SFU_SECRET|TURN_SECRET|POSTGRES_PASSWORD)=' .env
grep -E '^(DJANGO_SECRET_KEY|DJANGO_DEBUG|POSTGRES_PASSWORD)=' backend/.env
```

Если чего-то нет — добавить (`openssl rand -hex 32` на каждый секрет):

```bash
echo "SFU_SECRET=$(openssl rand -hex 32)" >> /opt/pskovcord/.env
```

**`TURN_SECRET` переехал в корневой `.env`.** До этого coturn читал его оттуда,
а Django — из `backend/.env`: стоило файлам разойтись, и Django подписывал
TURN-credentials одним ключом, а coturn проверял другим — relay тихо переставал
работать без внятной причины. Теперь источник один. Если на сервере значение
лежит только в `backend/.env`, **перенесите его в корневой `.env` тем же
значением** (менять его не нужно — иначе оборвутся текущие TURN-сессии).
- `SFU_PUBLIC_URL` и `SFU_ANNOUNCED_IP` **задавать не нужно** — прод-значения
  (`wss://pskord.zlgvpn.org/sfu` и `<SERVER_IP>`) зашиты в
  `deploy/docker-compose.prod.yml` и перекрывают `backend/.env`.

**Firewall на сервере** (вручную, не через docker — `sfu` в `network_mode: host`):

```bash
# Медиа SFU (голос + демонстрация экрана) — обязательно:
ufw allow 40000:40100/udp
ufw allow 40000:40100/tcp
```

Порт сигналинга `4443` наружу открывать **не нужно** (ходит только nginx с localhost).
Старые порты coturn (`3478`, `49160-49200/udp`) для голоса больше не используются —
можно закрыть, когда coturn будет удалён из стека.

## Ручные операции на сервере

```bash
ssh deploy@<SERVER_IP>   # ключ deploy_key, не пароль root

cd /opt/pskovcord
docker compose --env-file .env -f deploy/docker-compose.prod.yml ps
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f backend
```

Ручной передеплой (обычно не нужен — делает GitHub Actions):

```bash
bash /opt/pskovcord/deploy/deploy.sh
```

## Django-админка

Путь нарочно не `/admin/`, а `/adminpskordpro/` (см. `backend/config/urls.py`) — чтобы
не отсвечивать на типовой автоматической подборке путей. Статику (`admin/css`, `js`)
в проде раздаёт nginx напрямую из `/opt/pskovcord/deploy/staticfiles/`
(bind-mount, наполняется `collectstatic` при каждом старте контейнера backend —
см. `entrypoint.sh`), а не Django (в проде `DEBUG=0`, raw-сервер статику не отдаёт).
Это значит: **nginx-конфиг на сервере нужно обновить руками** (см. ниже) — сам
`deploy.sh` его не трогает, только код/контейнеры.

Тем же приёмом раздаются favicon-наборы (`core.models.Favicon`) — bind-mount
`/opt/pskovcord/deploy/media/` (создать вручную при первом деплое, `docker compose`
сам директорию не создаст) на `location /media/` в nginx (см. `deploy/nginx.conf.example`).

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
