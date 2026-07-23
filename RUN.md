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
| coturn (голос, STUN/TURN) | 3478 | Docker/WSL2 (см. ниже) |

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

Redis (Memurai) ставился через `choco install memurai-developer redis-64`.
Голос (coturn) на этой машине поднимается через Docker/WSL2 — своего Windows-бинарника
в проекте нет, см. `docker-compose.yml` за флагами запуска.

---

## Запуск (каждый раз)

Убедись, что службы PostgreSQL и Memurai запущены (обычно стартуют сами при загрузке).
Голос требует свой coturn — на этой машине он поднимается отдельно через Docker/WSL2:

```powershell
docker run --rm --network=host coturn/coturn --listening-port=3478 --min-port=49160 `
  --max-port=49200 --realm=pskovcord.local --use-auth-secret `
  --static-auth-secret=<TURN_SECRET из backend\.env>
```

Дальше — backend (применяет миграции и слушает :8000, отдаёт и собранный веб-клиент):

```powershell
cd D:\PSkovskiyCORD\backend
.\.venv\Scripts\python.exe manage.py migrate --noinput
.\.venv\Scripts\daphne.exe -b 0.0.0.0 -p 8000 config.asgi:application
```

Открой **http://localhost:8000**, зарегистрируйся, создай сервер (кнопка **+**),
добавь каналы, пиши в чат, заходи в голосовой канал.

> После изменений в коде фронта пересобери: `cd web; npm run build`.
> Для разработки с hot-reload: `cd web; npm run dev` (откроется на :5173).

---

## Тестовые пользователи

`druzhok / secret123` и `kolyan / secret123` (пароль можно менять при регистрации новых).

---

## Голос (свой WebRTC mesh)

- **Локально** (ты на этом ПК) или в одной LAN без строгого NAT: обычно работает и без
  запущенного coturn — браузеры находят друг друга по host/srflx ICE-кандидатам напрямую.
- coturn нужен, когда прямое соединение не проходит (за NAT/фаерволом) — тогда
  `backend\.env` должен указывать на реально запущенный `TURN_HOST`/`TURN_SECRET`,
  иначе голос в таких случаях просто не подключится.
- **Микрофон требует HTTPS** — браузеры дают доступ к микрофону только на `https://`
  или на `http://localhost`. Поэтому по `http://LAN-IP:8000` микрофон включить нельзя.

---

## Доступ друзьям (через интернет)

**Рекомендуется — реальный деплой** (см. [DEPLOY.md](DEPLOY.md)): `https://pskord.zlgvpn.org`
уже поднят на сервере со своим coturn, портами наружу и постоянным TLS. Это самый
надёжный вариант для друзей.

Разовый ad-hoc запуск с этого ПК через HTTP-туннель (cloudflared и т.п.) теперь работает
только частично: туннель прокидывает HTTPS-приложение, но **не** UDP-трафик голоса.
С self-hosted mesh это значит:

1. **HTTPS-туннель** для самого приложения — как раньше:

   ```powershell
   cloudflared tunnel --protocol http2 --url http://localhost:8000
   ```

   Даст адрес `https://...trycloudflare.com`. Текстовый чат и вход в сервер по нему заработают.

2. **Голос через туннель отдельно не поедет** — тоннель не тащит UDP TURN-relay coturn.
   Чтобы голос заработал с друзьями через интернет без реального сервера, нужно
   пробросить на роутере `3478/udp+tcp` и `49160-49200/udp` на эту машину и указать
   в `backend\.env` `TURN_HOST=<твой публичный IP>`. Это ощутимо больше телодвижений, чем
   раньше с LiveKit Cloud (там TURN был вообще не нужен со стороны клиента) — поэтому
   для разовых созвонов с друзьями практичнее задеплоить на реальный сервер.

> ⚠️ На этой сети (через v2rayN) HTTP-туннель нестабилен — рвётся соединение с Cloudflare
> (ошибка **1033**). Если отключить VPN и остаётся рабочий интернет — туннель станет
> стабильным.

---

## Остановить

```powershell
Get-Process daphne,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
```

(coturn, если запущен через `docker run`, остановить через `docker stop`/Ctrl+C в его окне.)

(PostgreSQL и Memurai — службы, останавливать не нужно.)

---

## Если что-то не так

- **Страница не грузится** — проверь, что бэкенд слушает: `Get-NetTCPConnection -LocalPort 8000 -State Listen`.
- **Микрофон не включается у друзей** — это HTTPS-ограничение (см. выше), нужен https-адрес.
- **Голос не соединяется** — обычно NAT/фаервол без рабочего TURN. Проверь, что coturn
  запущен и слушает :3478, а `TURN_HOST`/`TURN_SECRET` в `backend\.env` совпадают с тем,
  что реально настроено у coturn. После правки `.env` — перезапусти backend.
- **Ошибка 1033 у туннеля** — соединение cloudflared с Cloudflare оборвалось (сеть/VPN).
