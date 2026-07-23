# PskovCord — как запускать

Инструкция по локальному запуску (нативно, без Docker — как настроено на этой машине).

Продакшн: **https://pskord.zlgvpn.org** — деплоится автоматически при пуше в `main`
(см. [DEPLOY.md](DEPLOY.md)). Ветка `main` защищена, изменения — только через PR.

## Что где крутится

| Компонент | Порт | Чем поднят |
|-----------|------|-----------|
| Backend (API + WebSocket + отдаёт веб-клиент) | 8000 | Daphne (Python 3.11, `backend\.venv`) |
| Веб-клиент | — | собран в `web\dist`, отдаётся бэкендом (один адрес :8000) |
| PostgreSQL | 5432 | служба Windows `postgresql-x64-18` |
| Redis (presence + чат) | 6379 | служба `Memurai` |
| LiveKit (голос, SFU) | 7880 | `tools\livekit-server.exe` |

Открывать приложение: **http://localhost:8000**

---

## Разовая настройка (уже сделано, для справки/переустановки)

```powershell
# 1. БД и пользователь Postgres
"D:\PostgreSQL\bin\psql.exe" -U postgres -c "CREATE USER pskovcord WITH PASSWORD 'changeme'; CREATE DATABASE pskovcord OWNER pskovcord;"

# 2. venv бэкенда + зависимости
py -3.11 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
backend\.venv\Scripts\python.exe backend\manage.py migrate

# 3. веб-клиент
cd web
npm install
npm run build
cd ..
```

Redis (Memurai) и LiveKit ставились через `choco install memurai-developer redis-64`;
`tools\livekit-server.exe` скачан с github.com/livekit/livekit/releases.

---

## Запуск (каждый раз)

Убедись, что службы PostgreSQL и Memurai запущены (обычно стартуют сами при загрузке).
Дальше — один скрипт поднимает LiveKit + backend:

```powershell
powershell -ExecutionPolicy Bypass -File D:\PSkovskiyCORD\start-native.ps1
```

Открой **http://localhost:8000**, зарегистрируйся, создай сервер (кнопка **+**),
добавь каналы, пиши в чат, заходи в голосовой канал.

### Или вручную (если нужно видеть логи)

```powershell
# LiveKit (голос)
D:\PSkovskiyCORD\tools\livekit-server.exe --dev --bind 0.0.0.0 --node-ip 127.0.0.1

# Backend (в отдельном окне)
cd D:\PSkovskiyCORD\backend
.\.venv\Scripts\daphne.exe -b 0.0.0.0 -p 8000 config.asgi:application
```

> После изменений в коде фронта пересобери: `cd web; npm run build`.
> Для разработки с hot-reload: `cd web; npm run dev` (откроется на :5173).

---

## Тестовые пользователи

`druzhok / secret123` и `kolyan / secret123` (пароль можно менять при регистрации новых).

---

## Голос (LiveKit)

- **Локально** (ты на этом ПК): работает сразу, `backend\.env` указывает на `ws://localhost:7880`.
- **Микрофон требует HTTPS** — браузеры дают доступ к микрофону только на `https://`
  или на `http://localhost`. Поэтому по `http://LAN-IP:8000` микрофон включить нельзя.

---

## Доступ друзьям (через интернет)

Нужны два условия: приложение по **HTTPS** и LiveKit по **WSS+TURN**.

1. **LiveKit Cloud** (cloud.livekit.io, бесплатно): в `backend\.env` уже прописаны
   `LIVEKIT_URL=wss://...livekit.cloud`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
   (Вернуть локальный LiveKit — поставить обратно `ws://localhost:7880` / `devkey` / `secret`.)
2. **HTTPS-туннель** для приложения:

   ```powershell
   cloudflared tunnel --protocol http2 --url http://localhost:8000
   ```

   Даст адрес `https://...trycloudflare.com`. Дай его другу.

> ⚠️ На этой сети (через v2rayN) туннель нестабилен — рвётся соединение с Cloudflare
> (ошибка **1033**). Если отключить VPN и остаётся рабочий интернет — туннель станет
> стабильным. Надёжное решение для друзей — деплой на реальный сервер (см. TODO.md, Шаг деплоя).

---

## Остановить

```powershell
Get-Process livekit-server,daphne,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
```

(PostgreSQL и Memurai — службы, останавливать не нужно.)

---

## Если что-то не так

- **Страница не грузится** — проверь, что бэкенд слушает: `Get-NetTCPConnection -LocalPort 8000 -State Listen`.
- **Микрофон не включается у друзей** — это HTTPS-ограничение (см. выше), нужен https-адрес.
- **Голос не соединяется** — проверь, что LiveKit слушает :7880 (локально) или что ключи
  LiveKit Cloud в `backend\.env` верные. После правки `.env` — перезапусти backend.
- **Ошибка 1033 у туннеля** — соединение cloudflared с Cloudflare оборвалось (сеть/VPN).
