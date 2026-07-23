# PskovCord

Аналог Discord для группы друзей. Веб-first, клиент-серверное приложение, единый
центральный бэкенд, деплой на реальный сервер. Монорепо.

> Имя временное и живёт только в `APP_NAME` (env). Нигде не хардкодить.

## Стек

| Слой | Технологии |
|------|-----------|
| Фронт | React + Vite + TypeScript, `@livekit/components-react` |
| Бэкенд | Django + Django Channels (WebSocket) + DRF, SimpleJWT |
| БД / кэш | PostgreSQL, Redis (presence + Channels layer) |
| Голос/видео/экран | LiveKit (open-source SFU; на бэке только генерим токены) |
| Десктоп | Electron (тонкая обёртка над веб-билдом) |
| Инфра | Docker Compose (локально и на сервере) |

## Структура

```
.
├── backend/            # Django: accounts (auth), chat (серверы/каналы/чат/voice)
│   ├── config/         # settings, urls, asgi (Channels), wsgi
│   ├── accounts/       # кастомный User + JWT-регистрация/логин
│   └── chat/           # модели, REST, WebSocket-gateway, presence, LiveKit
├── web/                # React-клиент (Discord-раскладка)
├── desktop/            # Electron-обёртка
├── docker-compose.yml  # postgres, redis, livekit, backend, web
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

Поднимутся: PostgreSQL, Redis, LiveKit, Django (миграции применятся автоматически)
и Vite dev-сервер веб-клиента.

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
| livekit | 7880 | голос (dev-режим, ключи `devkey`/`secret`) |

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
| POST | `/api/channels/{id}/livekit-token` | токен для голоса |

WebSocket-gateway: `ws://localhost:8000/ws/gateway?token=<access>` — realtime-чат,
presence (online/offline) и voice-state (кто в голосовом канале).

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

# запуск всего стека (LiveKit + backend, backend отдаёт и web)
powershell -ExecutionPolicy Bypass -File start-native.ps1
```

Открыть: **http://localhost:8000**. Голос: `tools\livekit-server.exe` (dev-режим,
ключи `devkey`/`secret`) — качается отдельно с github.com/livekit/livekit/releases.

`backend\.env` для нативного режима указывает на `127.0.0.1` (Postgres/Redis) и
`ws://localhost:7880` (LiveKit). Веб собирается в single-origin (`web\.env.production`
с пустыми URL) и отдаётся самим бэкендом.

> Голос: LiveKit в dev-режиме использует `--node-ip 127.0.0.1` для локали. Для LAN/удалёнки
> нужен реальный IP/хост и проброс UDP-порта `7882` — через простой HTTP-туннель голос не пойдёт.

## Заметки

- Миграции закоммичены; на старте контейнера backend применяются
  (`entrypoint.sh` → `migrate`). После правок моделей — `makemigrations`.
- CORS в DEBUG открыт для всех источников — сузить перед боевым деплоем.
- LiveKit в dev-режиме использует встроенные ключи; для сервера задать реальные
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` и внешний `LIVEKIT_URL`.
