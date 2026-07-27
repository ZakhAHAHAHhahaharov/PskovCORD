import * as mediasoup from 'mediasoup'
import type { types } from 'mediasoup'
import { config } from './config'

const workers: types.Worker[] = []
let nextWorker = 0

/** Поднять пул mediasoup-воркеров (по одному C++-процессу на воркер). */
export async function initWorkers(): Promise<void> {
  for (let i = 0; i < Math.max(1, config.numWorkers); i++) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: config.rtcMinPort,
      rtcMaxPort: config.rtcMaxPort,
      logLevel: 'warn',
    })
    worker.on('died', () => {
      // Раньше здесь был безусловный process.exit(1): смерть ОДНОГО воркера
      // уносила все комнаты на всех воркерах, хотя пул на то и пул. Теперь
      // выкидываем только упавший — mediasoup сам закроет его роутеры,
      // участники тех комнат увидят обрыв и переподключатся (клиент это
      // умеет, см. web/src/voice.ts), сев уже на живой воркер.
      console.error(`[sfu] mediasoup worker ${worker.pid} died`)
      const index = workers.indexOf(worker)
      if (index !== -1) workers.splice(index, 1)
      if (workers.length === 0) {
        console.error('[sfu] не осталось ни одного воркера — выходим')
        process.exit(1)
      }
    })
    workers.push(worker)
  }
  console.log(`[sfu] started ${workers.length} mediasoup worker(s)`)
}

/** Round-robin по воркерам — каждая комната садится на следующий воркер. */
export function pickWorker(): types.Worker {
  if (workers.length === 0) throw new Error('нет живых mediasoup-воркеров')
  // Пул мог сократиться после смерти воркера (см. initWorkers) — приводим
  // курсор к текущей длине, иначе он указывал бы за конец массива.
  if (nextWorker >= workers.length) nextWorker = 0
  const worker = workers[nextWorker]
  nextWorker = (nextWorker + 1) % workers.length
  return worker
}

/** WebRtcTransport с announcedIp/портами из конфига. */
export function createWebRtcTransport(
  router: types.Router,
): Promise<types.WebRtcTransport> {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: config.announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 800_000,
  })
}
