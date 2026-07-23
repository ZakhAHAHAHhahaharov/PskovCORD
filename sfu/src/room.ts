import type { WebSocket } from 'ws'
import type { types } from 'mediasoup'
import { pickWorker } from './worker'
import { mediaCodecs } from './config'

let peerSeq = 0

/**
 * Peer — одно WS-соединение клиента внутри комнаты. Держит свои send/recv
 * WebRtcTransport'ы, продюсеров (свой микрофон) и консюмеров (чужие треки).
 * userId может повторяться (две вкладки) — идентичность соединения = id.
 */
export class Peer {
  readonly id: string
  readonly userId: number
  readonly socket: WebSocket
  sendTransport?: types.WebRtcTransport
  recvTransport?: types.WebRtcTransport
  readonly producers = new Map<string, types.Producer>()
  readonly consumers = new Map<string, types.Consumer>()

  constructor(userId: number, socket: WebSocket) {
    this.id = `p${++peerSeq}`
    this.userId = userId
    this.socket = socket
  }

  /** Ответ на запрос клиента (по его id) либо серверное уведомление. */
  send(payload: unknown): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload))
    }
  }

  notify(notification: string, data: unknown): void {
    this.send({ notification, data })
  }

  transport(id: string): types.WebRtcTransport | undefined {
    if (this.sendTransport?.id === id) return this.sendTransport
    if (this.recvTransport?.id === id) return this.recvTransport
    return undefined
  }

  /** Закрыть все ресурсы пира (транспорты каскадно закрывают producer/consumer). */
  close(): void {
    for (const consumer of this.consumers.values()) consumer.close()
    for (const producer of this.producers.values()) producer.close()
    this.sendTransport?.close()
    this.recvTransport?.close()
    this.consumers.clear()
    this.producers.clear()
  }
}

/**
 * Room — один голосовой канал = один mediasoup Router. Держит реестр пиров и
 * индекс продюсеров (кто чей), чтобы новому пиру выдать существующие потоки и
 * оповещать остальных о новых.
 */
export class Room {
  readonly id: string
  readonly router: types.Router
  readonly peers = new Map<string, Peer>()

  private constructor(id: string, router: types.Router) {
    this.id = id
    this.router = router
  }

  static async create(id: string): Promise<Room> {
    const worker = pickWorker()
    const router = await worker.createRouter({ mediaCodecs })
    return new Room(id, router)
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer)
  }

  removePeer(peer: Peer): void {
    this.peers.delete(peer.id)
  }

  get empty(): boolean {
    return this.peers.size === 0
  }

  /** Все продюсеры комнаты, кроме принадлежащих указанному пиру. */
  otherProducers(except: Peer): { producerId: string; userId: number }[] {
    const out: { producerId: string; userId: number }[] = []
    for (const peer of this.peers.values()) {
      if (peer.id === except.id) continue
      for (const producer of peer.producers.values()) {
        out.push({ producerId: producer.id, userId: peer.userId })
      }
    }
    return out
  }

  /** Разослать уведомление всем пирам комнаты, кроме одного. */
  broadcast(except: Peer, notification: string, data: unknown): void {
    for (const peer of this.peers.values()) {
      if (peer.id === except.id) continue
      peer.notify(notification, data)
    }
  }
}

/**
 * Реестр комнат по channel_id. Комната создаётся лениво при первом входе и
 * удаляется, когда пустеет (роутер закрывается, освобождая ресурсы воркера).
 */
export class Rooms {
  private static rooms = new Map<string, Room>()
  private static pending = new Map<string, Promise<Room>>()

  static async get(id: string): Promise<Room> {
    const existing = Rooms.rooms.get(id)
    if (existing) return existing
    // Гонка одновременных входов в новую комнату: создаём Router один раз.
    let creating = Rooms.pending.get(id)
    if (!creating) {
      creating = Room.create(id).then((room) => {
        Rooms.rooms.set(id, room)
        Rooms.pending.delete(id)
        return room
      })
      Rooms.pending.set(id, creating)
    }
    return creating
  }

  static maybeClose(room: Room): void {
    if (room.empty) {
      room.router.close()
      Rooms.rooms.delete(room.id)
    }
  }
}
