import type { types } from 'mediasoup'

/**
 * Конфиг SFU читается из окружения (те же переменные, что в .env.example).
 * SFU_SECRET должен совпадать с Django — им подписан access-токен клиента.
 */
export const config = {
  listenPort: Number(process.env.SFU_LISTEN_PORT || 4443),
  sfuSecret: process.env.SFU_SECRET || 'dev-insecure-sfu-secret',
  // IP, который SFU сообщает клиентам в ICE-кандидатах. Локально — 127.0.0.1,
  // на сервере — реальный публичный IP (иначе медиа не дойдёт).
  announcedIp: process.env.SFU_ANNOUNCED_IP || '127.0.0.1',
  rtcMinPort: Number(process.env.SFU_RTC_MIN_PORT || 40000),
  rtcMaxPort: Number(process.env.SFU_RTC_MAX_PORT || 40100),
  numWorkers: Number(process.env.SFU_NUM_WORKERS || 1),
}

/**
 * Кодеки роутера. Opus нужен для голоса сейчас; VP8/H264 заложены заранее,
 * чтобы добавление видео/screenshare потом не требовало смены роутера
 * (продюсим пока только audio — наличие видео-кодеков ничему не мешает).
 */
export const mediaCodecs: types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {},
  },
]
