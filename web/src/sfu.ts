import { Device } from 'mediasoup-client'
import type { types } from 'mediasoup-client'

export type SfuStatus = 'connecting' | 'connected' | 'failed'

export interface SfuCallbacks {
  /** Появился/обновился аудиопоток участника userId. */
  onRemoteStream: (userId: number, stream: MediaStream) => void
  /** Участник userId ушёл — убрать его поток. */
  onRemoteRemoved: (userId: number) => void
  onStatus: (status: SfuStatus) => void
}

interface Pending {
  resolve: (data: any) => void
  reject: (err: Error) => void
}

/**
 * Клиент собственного SFU (mediasoup). Держит ОДНО WS-соединение к SFU и один
 * send + один recv WebRTC-транспорт: свой микрофон уходит одним потоком
 * (Producer), а чужие потоки приходят Consumer'ами. Это заменяет прежний P2P
 * full-mesh (по соединению на каждого участника).
 *
 * Наружу отдаём готовые MediaStream'ы, ключёванные по userId — тот же контракт,
 * что был у mesh (remoteStreams: Map<userId, MediaStream>), поэтому UI и VAD в
 * voice.ts не меняются.
 */
export class SfuClient {
  private ws: WebSocket | null = null
  private device = new Device()
  private sendTransport?: types.Transport
  private recvTransport?: types.Transport
  private micProducer?: types.Producer
  private readonly consumers = new Map<string, types.Consumer>()
  private readonly consumerUser = new Map<string, number>()
  private readonly userStreams = new Map<number, MediaStream>()
  private readonly pending = new Map<number, Pending>()
  private nextReqId = 1
  private closed = false

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly cb: SfuCallbacks,
  ) {}

  /** Полный цикл подключения: WS → Device → транспорты → produce → consume. */
  async connect(micTrack: MediaStreamTrack | null): Promise<void> {
    this.cb.onStatus('connecting')
    try {
      await this.openSocket()
      const routerRtpCapabilities = await this.request('getRouterRtpCapabilities')
      await this.device.load({ routerRtpCapabilities })

      await this.createRecvTransport()
      await this.createSendTransport()

      if (micTrack) {
        this.micProducer = await this.sendTransport!.produce({ track: micTrack })
      }

      // Подписаться на уже присутствующих участников.
      const producers = (await this.request('getProducers')) as {
        producerId: string
        userId: number
      }[]
      for (const p of producers) await this.consume(p.producerId, p.userId)
    } catch (err) {
      if (!this.closed) this.cb.onStatus('failed')
      throw err
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sep = this.url.includes('?') ? '&' : '?'
      const ws = new WebSocket(`${this.url}${sep}token=${encodeURIComponent(this.token)}`)
      this.ws = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('SFU WebSocket error'))
      ws.onclose = () => {
        if (!this.closed) this.cb.onStatus('failed')
      }
      ws.onmessage = (e) => this.onMessage(e.data)
    })
  }

  private onMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.notification) {
      this.onNotification(msg.notification, msg.data)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.data)
  }

  private onNotification(notification: string, data: any) {
    switch (notification) {
      case 'newProducer':
        // Не ждём результата — consume асинхронно.
        void this.consume(data.producerId, data.userId)
        break
      case 'peerClosed':
        this.removeUser(data.userId)
        break
      case 'consumerClosed': {
        const uid = this.consumerUser.get(data.consumerId)
        this.consumers.get(data.consumerId)?.close()
        this.consumers.delete(data.consumerId)
        this.consumerUser.delete(data.consumerId)
        if (uid != null) this.recomputeUserStream(uid)
        break
      }
    }
  }

  private request(action: string, data?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('SFU socket not open'))
        return
      }
      const id = this.nextReqId++
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, action, data }))
    })
  }

  private async createRecvTransport() {
    const params = await this.request('createWebRtcTransport', { direction: 'recv' })
    const transport = this.device.createRecvTransport(params)
    this.wireTransportConnect(transport)
    this.recvTransport = transport
  }

  private async createSendTransport() {
    const params = await this.request('createWebRtcTransport', { direction: 'send' })
    const transport = this.device.createSendTransport(params)
    this.wireTransportConnect(transport)
    // Отдельно: серверу нужно создать Producer при первом produce().
    transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      this.request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
      })
        .then((res: { id: string }) => callback({ id: res.id }))
        .catch(errback)
    })
    // Статус голоса считаем по состоянию именно send-транспорта.
    transport.on('connectionstatechange', (state) => {
      if (state === 'connected') this.cb.onStatus('connected')
      else if (state === 'failed' || state === 'disconnected') {
        if (!this.closed) this.cb.onStatus('failed')
      }
    })
    this.sendTransport = transport
  }

  private wireTransportConnect(transport: types.Transport) {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('connectWebRtcTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback)
    })
  }

  private async consume(producerId: string, userId: number) {
    if (this.closed || !this.recvTransport) return
    try {
      const params = await this.request('consume', {
        producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      })
      const consumer = await this.recvTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      })
      const uid = (params.producerUserId as number | null) ?? userId
      this.consumers.set(consumer.id, consumer)
      this.consumerUser.set(consumer.id, uid)
      consumer.on('transportclose', () => {
        this.consumers.delete(consumer.id)
        this.consumerUser.delete(consumer.id)
      })
      // Сервер стартует консюмера на паузе — снимаем после setup.
      await this.request('resumeConsumer', { consumerId: consumer.id })
      this.recomputeUserStream(uid)
    } catch {
      // Один неудавшийся consume не должен ронять весь голос.
    }
  }

  /** Собрать MediaStream пользователя из его действующих консюмеров. */
  private recomputeUserStream(userId: number) {
    const tracks: MediaStreamTrack[] = []
    for (const [cid, consumer] of this.consumers) {
      if (this.consumerUser.get(cid) === userId) tracks.push(consumer.track)
    }
    if (tracks.length === 0) {
      this.userStreams.delete(userId)
      this.cb.onRemoteRemoved(userId)
      return
    }
    const stream = new MediaStream(tracks)
    this.userStreams.set(userId, stream)
    this.cb.onRemoteStream(userId, stream)
  }

  private removeUser(userId: number) {
    for (const [cid, uid] of this.consumerUser) {
      if (uid === userId) {
        this.consumers.get(cid)?.close()
        this.consumers.delete(cid)
        this.consumerUser.delete(cid)
      }
    }
    this.userStreams.delete(userId)
    this.cb.onRemoteRemoved(userId)
  }

  /** Мьют своего микрофона: пауза Producer'а останавливает отправку RTP. */
  setMicPaused(paused: boolean) {
    if (!this.micProducer) return
    if (paused && !this.micProducer.paused) this.micProducer.pause()
    else if (!paused && this.micProducer.paused) this.micProducer.resume()
  }

  /** Средний RTT (мс) по активной candidate-pair send-транспорта. */
  async pingMs(): Promise<number | null> {
    if (!this.sendTransport) return null
    try {
      const stats = await this.sendTransport.getStats()
      let rtt: number | null = null
      stats.forEach((report: any) => {
        if (
          report.type === 'candidate-pair' &&
          (report.nominated ?? report.state === 'succeeded') &&
          typeof report.currentRoundTripTime === 'number'
        ) {
          rtt = report.currentRoundTripTime * 1000
        }
      })
      return rtt
    } catch {
      return null
    }
  }

  close() {
    this.closed = true
    for (const c of this.consumers.values()) c.close()
    this.consumers.clear()
    this.consumerUser.clear()
    this.userStreams.clear()
    this.micProducer?.close()
    this.sendTransport?.close()
    this.recvTransport?.close()
    this.pending.clear()
    this.ws?.close()
    this.ws = null
  }
}
