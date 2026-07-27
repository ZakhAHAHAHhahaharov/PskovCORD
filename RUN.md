# PskovCord — как запускать

Продакшн: **https://pskord.zlgvpn.org** — деплоится автоматически при пуше в `main`
(см. [DEPLOY.md](DEPLOY.md)). Ветка `main` защищена, изменения — только через PR.

## Локальный запуск

```bash
cp .env.example .env
docker compose up --build
```

Поднимутся: PostgreSQL, Redis, backend (Django, миграции применяются автоматически),
SFU (голос, mediasoup) и веб-клиент (Vite dev-сервер).

- Веб-клиент: http://localhost:5173
- Backend: http://localhost:8000/ и http://localhost:8000/healthz

Зарегистрируйся, создай сервер (кнопка **+** в левом рейле), добавь каналы,
пиши в чат, заходи в голосовой канал.

## Тестовые пользователи

`druzhok / secret123` и `kolyan / secret123` (пароль можно менять при регистрации новых).

## Если что-то не так

- **Микрофон не включается** — браузеры дают доступ к микрофону только на `https://`
  или на `http://localhost`. По адресу вида `http://<LAN-IP>:5173` не заработает.
- Архитектура голоса (SFU/mediasoup), продакшн-инфраструктура и деплой — см.
  [DEPLOY.md](DEPLOY.md).
