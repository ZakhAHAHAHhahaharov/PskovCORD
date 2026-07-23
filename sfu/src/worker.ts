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
      // Воркер упал — без него медиа не работает, поднимаемся заново процессом.
      console.error(`[sfu] mediasoup worker ${worker.pid} died, exiting`)
      process.exit(1)
    })
    workers.push(worker)
  }
  console.log(`[sfu] started ${workers.length} mediasoup worker(s)`)
}

/** Round-robin по воркерам — каждая комната садится на следующий воркер. */
export function pickWorker(): types.Worker {
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
