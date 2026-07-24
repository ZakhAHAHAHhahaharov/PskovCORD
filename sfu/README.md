# PskovCord SFU (mediasoup)

Медиа-сервер голоса. Заменяет прежнюю P2P-mesh модель: клиент держит **один**
WebRTC-транспорт к этому сервису, а SFU разветвляет потоки остальным
участникам канала. Масштабируется на десятки участников и готов к видео.

## Роль в системе

- **Django gateway** остаётся владельцем «меты» голоса (presence, кто в каком
  канале, мьют, call-state) и выдаёт клиенту короткоживущий access-токен
  (`chat/sfu.py`, подпись `SFU_SECRET`).
- **Этот сервис** отвечает только за медиа: проверяет токен, поднимает
  mediasoup `Router` на голосовой канал и WebRtcTransport'ы на клиента.

## Протокол сигналинга (WS)

Клиент подключается: `ws://<host>:<port>/?token=<sfu_token>`.
Request/response поверх WS — `{id, action, data}` → `{id, data|error}`:

| action | назначение |
|--------|-----------|
| `getRouterRtpCapabilities` | capabilities роутера для `Device.load` |
| `createWebRtcTransport {direction}` | создать send/recv транспорт |
| `connectWebRtcTransport {transportId, dtlsParameters}` | DTLS-connect |
| `produce {transportId, kind, rtpParameters}` | опубликовать микрофон |
| `getProducers` | список чужих продюсеров для consume |
| `consume {producerId, rtpCapabilities}` | подписаться на чужой поток |
| `resumeConsumer {consumerId}` | снять паузу с консюмера |

Серверные уведомления: `newProducer {producerId, userId}`,
`consumerClosed {consumerId}`, `peerClosed {userId}`.

## Запуск

Docker: сервис `sfu` в корневом `docker-compose.yml` (`network_mode: host`).

Нативно (Windows, без Docker): `./run-native.ps1`.

## Переменные окружения

См. `.env.example` в корне (блок SFU): `SFU_SECRET` (совпадает с Django),
`SFU_LISTEN_PORT`, `SFU_ANNOUNCED_IP` (публичный/LAN IP для ICE),
`SFU_RTC_MIN_PORT`/`SFU_RTC_MAX_PORT` (UDP/TCP-диапазон медиа — открыть на фаерволе).
