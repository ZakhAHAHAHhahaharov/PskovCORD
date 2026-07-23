# desktop/ — Electron-обёртка PskovCord

Тонкая обёртка над тем же веб-билдом, что и браузерный клиент (как у Discord).

## Dev

1. Подними бэкенд: `docker compose up` (из корня репо).
2. Подними веб-клиент: `cd web && npm install && npm run dev`.
3. В другом терминале:

   ```bash
   cd desktop
   npm install
   npm start
   ```

   Откроется окно Electron, загрузив `http://localhost:5173`.

## Production (позже)

- Собрать веб: `cd web && npm run build` → `web/dist`.
- Запаковать: `cd desktop && npm run build` (нужен `electron-builder`).

В упакованном виде Electron грузит `web/dist/index.html`. API-адрес зашивается
на этапе сборки веба через `VITE_API_URL` / `VITE_WS_URL`.
