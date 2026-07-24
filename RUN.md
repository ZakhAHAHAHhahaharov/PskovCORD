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
| **SFU (голос, mediasoup)** | 4443 (WS) + 40000-40100 (UDP/TCP медиа) | Node (`sfu\`, `run-native.ps1`) |
| coturn (STUN/TURN) | 3478 | *не нужен для SFU* — mediasoup сам себе ICE-эндпоинт (легаси mesh) |

Открывать приложение: **http://localhost:8000**

> **Голос переведён с P2P-mesh на собственный SFU (mediasoup).** Клиент держит
> одно WebRTC-соединение к сервису `sfu/`, а тот разветвляет звук остальным.
> coturn на медиа-леге SFU больше не участвует.

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

# 4. SFU (mediasoup) — медиа-сервер голоса
cd sfu
npm install       # тянет prebuilt mediasoup-worker; через прокси см. заметку ниже
npm run build
cd ..
```

Redis (Memurai) ставился через `choco install memurai-developer redis-64`.

**Про установку SFU за прокси (v2rayN):** `mediasoup` при `npm install` докачивает
prebuilt worker-бинарь с GitHub. Если прямого интернета нет, настрой прокси для npm:

```powershell
npm config set proxy http://127.0.0.1:10809
npm config set https-proxy http://127.0.0.1:10809
```

(prebuilt worker под Windows x64 ставится штатно; сборка из исходников — только
если под платформу нет prebuilt, тогда нужны Python 3 + MSVC build tools.)

---

## Запуск (каждый раз)

Убедись, что службы PostgreSQL и Memurai запущены (обычно стартуют сами при загрузке).

Голос требует запущенный SFU-сервис. В отдельном окне:

```powershell
cd D:\PSkovskiyCORD\sfu
.\run-native.ps1
```

(скрипт подхватывает `SFU_*` из корневого `.env`, иначе берёт dev-дефолты:
порт 4443, `SFU_ANNOUNCED_IP=127.0.0.1`, медиа-порты 40000-40100. Секрет
`SFU_SECRET` должен совпадать с бэкендом — по умолчанию совпадает.)

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

## Голос (свой SFU на mediasoup)

- Клиент подключается **одним** WebRTC-транспортом к SFU-сервису (`sfu/`, порт 4443),
  а тот пересылает звук остальным участникам канала. Это заменило прежний P2P-mesh
  (по соединению на каждого) — так масштабируется на десятки участников и готово к видео.
- Django выдаёт клиенту короткоживущий `sfu_token` (эндпоинт voice-credentials),
  SFU его проверяет тем же секретом `SFU_SECRET`. Presence/кто-в-канале/мьют остаются
  в бэкенде — SFU отвечает только за медиа.
- **ICE/порты:** mediasoup сам себе ICE-эндпоинт. Клиенту он сообщает `SFU_ANNOUNCED_IP`
  и слушает медиа на UDP/TCP-диапазоне `SFU_RTC_MIN_PORT..MAX_PORT` (по умолч. 40000-40100).
  Локально `SFU_ANNOUNCED_IP=127.0.0.1`; на сервере/в LAN — реальный публичный/LAN IP,
  и этот диапазон портов должен быть открыт на фаерволе. coturn для этого не нужен.
- **Микрофон требует HTTPS** — браузеры дают доступ к микрофону только на `https://`
  или на `http://localhost`. Поэтому по `http://LAN-IP:8000` микрофон включить нельзя.
- **Демонстрация экрана** (кнопка 🖥️ рядом с микрофоном, когда в голосе): через
  `getDisplayMedia`, видео (VP8) и системный звук идут через тот же SFU отдельным
  Producer'ом с меткой `source=screen`. Тоже требует HTTPS/localhost. Демонстрации
  участников показываются видео-тайлами в основной области.

---

## Доступ друзьям (через интернет)

**Рекомендуется — реальный деплой** (см. [DEPLOY.md](DEPLOY.md)): `https://pskord.zlgvpn.org`
уже поднят на сервере со своим coturn, портами наружу и постоянным TLS. Это самый
надёжный вариант для друзей.

Разовый ad-hoc запуск с этого ПК через HTTP-туннель (cloudflared и т.п.) работает
только частично: туннель прокидывает HTTPS-приложение, но **не** UDP-трафик голоса.
С собственным SFU это значит:

1. **HTTPS-туннель** для самого приложения — как раньше:

   ```powershell
   cloudflared tunnel --protocol http2 --url http://localhost:8000
   ```

   Даст адрес `https://...trycloudflare.com`. Текстовый чат и вход в сервер по нему заработают.

2. **Голос через туннель отдельно не поедет** — тоннель не тащит UDP-медиа SFU.
   Чтобы голос заработал с друзьями через интернет без реального сервера, нужно
   пробросить на роутере медиа-диапазон SFU (`40000-40100/udp+tcp`) и порт сигналинга
   `4443/tcp` на эту машину, а в `.env` задать `SFU_ANNOUNCED_IP=<твой публичный IP>` и
   `SFU_PUBLIC_URL=wss://<адрес туннеля/домен>` (клиент должен резолвить SFU по HTTPS).
   Это заметно больше телодвижений — для разовых созвонов практичнее задеплоить на сервер.

> ⚠️ На этой сети (через v2rayN) HTTP-туннель нестабилен — рвётся соединение с Cloudflare
> (ошибка **1033**). Если отключить VPN и остаётся рабочий интернет — туннель станет
> стабильным.

---

## Остановить

```powershell
Get-Process daphne,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
# SFU (Node) — по окну run-native.ps1 (Ctrl+C) или:
Get-CimInstance Win32_Process | Where-Object CommandLine -like '*dist/index.js*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

(PostgreSQL и Memurai — службы, останавливать не нужно.)

---

## Если что-то не так

- **Страница не грузится** — проверь, что бэкенд слушает: `Get-NetTCPConnection -LocalPort 8000 -State Listen`.
- **Микрофон не включается у друзей** — это HTTPS-ограничение (см. выше), нужен https-адрес.
- **Голос не соединяется** — проверь, что SFU запущен и слушает :4443
  (`Get-NetTCPConnection -LocalPort 4443 -State Listen`), а `SFU_SECRET` у SFU и backend
  совпадает (иначе токен не проходит проверку). Если участники за NAT/через интернет —
  `SFU_ANNOUNCED_IP` должен быть их достижимым IP, а медиа-порты 40000-40100 — открыты.
- **Голос не подключается только удалённо, локально ок** — почти всегда `SFU_ANNOUNCED_IP`
  стоит `127.0.0.1` (годится лишь для этого же ПК) или закрыт UDP-диапазон медиа.
- **Ошибка 1033 у туннеля** — соединение cloudflared с Cloudflare оборвалось (сеть/VPN).
