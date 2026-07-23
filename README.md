# PskovCord

Аналог Discord для группы друзей. Веб-first, клиент-серверное приложение, единый
центральный бэкенд, деплой на реальный сервер. Монорепо.

> Имя временное и живёт только в `APP_NAME` (env). Нигде не хардкодить.

## Стек

| Слой | Технологии |
|------|-----------|
| Фронт | React + Vite + TypeScript |
| Бэкенд | Django + Django Channels (WebSocket) + DRF, SimpleJWT |
| БД / кэш | PostgreSQL, Redis (presence + Channels layer) |
| Голос | Свой WebRTC P2P mesh: сигналинг через `/ws/gateway`, STUN/TURN — свой coturn |
| Десктоп | Electron (тонкая обёртка над веб-билдом) |
| Инфра | Docker Compose (локально и на сервере) |

## Структура

```
.
├── backend/            # Django: accounts (auth), chat (серверы/каналы/чат/voice)
│   ├── config/         # settings, urls, asgi (Channels), wsgi
│   ├── accounts/       # кастомный User + JWT-регистрация/логин
│   └── chat/           # модели, REST, WebSocket-gateway, presence, voice-сигналинг/TURN
├── web/                # React-клиент (Discord-раскладка)
├── desktop/            # Electron-обёртка
├── docker-compose.yml  # postgres, redis, coturn, backend, web
├── .env.example        # переменные, включая APP_NAME
└── TODO.md             # исходный план
```

## Быстрый старт (весь стек одной командой)

```bash
cp .env.example .env
```
```bash
docker compose up --build
```

Поднимутся: PostgreSQL, Redis, coturn (STUN/TURN), Django (миграции применятся
автоматически) и Vite dev-сервер веб-клиента.

- Веб-клиент: http://localhost:5173
- Бэкенд: http://localhost:8000/ и http://localhost:8000/healthz

Дальше: зарегистрируйся, создай сервер (кнопка **+** в левом рейле), добавь каналы,
пиши в чат, заходи в голосовой канал.

## Сервисы (порты)

| Сервис | Порт | Назначение |
|--------|------|-----------|
| web | 5173 | React-клиент (Vite) |
| backend | 8000 | Django API + WebSocket (`/ws/gateway`) |
| postgres | 5432 | БД |
| redis | 6379 | presence + Channels layer |
| coturn | 3478 (udp/tcp), 49160-49200/udp | STUN/TURN для голоса (dev-секрет из `.env`) |

## API (кратко)

| Метод | Путь | Назначение |
|-------|------|-----------|
| POST | `/api/auth/register` | регистрация → JWT |
| POST | `/api/auth/token` | логин → JWT |
| GET | `/api/auth/me` | текущий пользователь |
| GET/POST | `/api/servers` | список / создание серверов |
| GET | `/api/servers/discover` | все серверы (для вступления) |
| POST | `/api/servers/{id}/join` | вступить |
| GET | `/api/servers/{id}/members` | участники + presence |
| POST | `/api/servers/{id}/channels` | создать канал |
| GET | `/api/channels/{id}/messages` | история сообщений |
| POST | `/api/channels/{id}/voice-credentials` | STUN/TURN ICE-servers для входа в голос |

WebSocket-gateway: `ws://localhost:8000/ws/gateway?token=<access>` — realtime-чат,
presence (online/offline), voice-state (кто в голосовом канале) и WebRTC-сигналинг
(SDP offer/answer, ICE-кандидаты) для P2P-mesh голоса.

## Десктоп (Electron)

См. [desktop/README.md](desktop/README.md). Кратко: подними бэкенд и `web` (dev),
затем `cd desktop && npm install && npm start`.

## Нативный запуск (Windows, без Docker)

Если Docker недоступен. Требуется: PostgreSQL и Redis (или Memurai) как службы,
Python 3.11, Node.

```powershell
# один раз: БД, venv, сборка web
"D:\PostgreSQL\bin\psql.exe" -U postgres -c "CREATE USER pskovcord WITH PASSWORD 'changeme'; CREATE DATABASE pskovcord OWNER pskovcord;"
py -3.11 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
cd web; npm install; npm run build; cd ..

# запуск backend (применяет миграции, слушает :8000, отдаёт и собранный web)
backend\.venv\Scripts\python.exe backend\manage.py migrate --noinput
backend\.venv\Scripts\daphne.exe -b 0.0.0.0 -p 8000 config.asgi:application
```

Открыть: **http://localhost:8000**. Голос требует свой STUN/TURN (coturn) — под Windows
без Docker проще всего поднять его через WSL2/Docker Desktop (`docker run --network=host
coturn/coturn ...`, см. флаги в `docker-compose.yml`), нативного `coturn.exe` в проекте нет.

`backend\.env` для нативного режима указывает на `127.0.0.1` (Postgres/Redis) и
на `TURN_HOST`/`TURN_SECRET` своего coturn. Веб собирается в single-origin
(`web\.env.production` с пустыми URL) и отдаётся самим бэкендом.

> Голос: для локальных тестов на одной машине/LAN TURN обычно не нужен (прямые
> host-кандидаты уже работают). Для доступа через интернет — нужны реальный
> IP/хост и проброс `3478/udp+tcp` + relay-диапазона `49160-49200/udp` — через
> простой HTTP-туннель (cloudflared и т.п.) голос не пойдёт, TURN тоже нужно
> прокидывать отдельно.

## Заметки

- `web/src/version.ts` — версия, которая светится бейджем в правом нижнем углу
  UI (что реально задеплоено на сервере). При каждой новой фиче инкрементируй
  `version` (semver) и обнови `note` (коротко, 2-3 слова).
- Миграции закоммичены; на старте контейнера backend применяются
  (`entrypoint.sh` → `migrate`). После правок моделей — `makemigrations`.
- CORS в DEBUG открыт для всех источников — сузить перед боевым деплоем.
- coturn в dev-режиме использует секрет из `.env` (`TURN_SECRET`); для сервера
  сгенерировать свой (`openssl rand -hex 32`) и задать реальный `TURN_HOST`.
