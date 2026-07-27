import type { types } from 'mediasoup'

/**
 * Конфиг SFU читается из окружения (те же переменные, что в .env.example).
 * SFU_SECRET должен совпадать с Django — им подписан access-токен клиента.
 */
/** Значение, которое раньше стояло фолбэком прямо в коде и лежит в
 * .env.example / обоих compose-файлах — то есть публично известно. */
const KNOWN_INSECURE_SECRET = 'dev-insecure-sfu-secret'

/**
 * Секрет подписи access-токенов. Фолбэка нет намеренно.
 *
 * Раньше было `process.env.SFU_SECRET || 'dev-insecure-sfu-secret'`, и такой
 * же дефолт стоял на стороне Django и в prod-compose. Стоило забыть
 * переменную на сервере — обе стороны молча сходились на общеизвестном
 * секрете, и кто угодно мог подписать себе токен в любую голосовую комнату.
 * Отказ стартовать заметен сразу; тихая деградация до публичного секрета —
 * нет. Для локальной разработки есть явный SFU_ALLOW_DEV_SECRET=1.
 */
function readSecret(): string {
  const secret = process.env.SFU_SECRET
  const allowDev = process.env.SFU_ALLOW_DEV_SECRET === '1'
  if (!secret) {
    throw new Error(
      '[sfu] SFU_SECRET не задан. Сгенерируйте `openssl rand -hex 32` и задайте ' +
        'один и тот же секрет бэкенду и SFU (для локальной разработки — ' +
        'SFU_ALLOW_DEV_SECRET=1).',
    )
  }
  if (secret === KNOWN_INSECURE_SECRET && !allowDev) {
    throw new Error(
      '[sfu] SFU_SECRET равен общеизвестному значению из .env.example. ' +
        'Сгенерируйте настоящий (`openssl rand -hex 32`) или выставьте ' +
        'SFU_ALLOW_DEV_SECRET=1, если это точно локальная машина.',
    )
  }
  return secret
}

export const config = {
  listenPort: Number(process.env.SFU_LISTEN_PORT || 4443),
  // Интерфейс WS-сигналинга. В проде — 127.0.0.1: наружу его проксирует nginx
  // (wss), поэтому порт не должен торчать в интернет.
  listenHost: process.env.SFU_LISTEN_HOST || '0.0.0.0',
  sfuSecret: readSecret(),
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
