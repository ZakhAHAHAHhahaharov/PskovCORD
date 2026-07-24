import { Device } from 'mediasoup-client'
import type { types } from 'mediasoup-client'

export type SfuStatus = 'connecting' | 'connected' | 'failed'

/** Тип потока: голос (микрофон) или демонстрация экрана. */
type Source = 'mic' | 'screen'

export interface SfuCallbacks {
  /** Появился/обновился голосовой поток участника userId. */
  onRemoteStream: (userId: number, stream: MediaStream) => void
  /** Голосовой поток участника userId пропал. */
  onRemoteRemoved: (userId: number) => void
  /** Появилась/обновилась демонстрация экрана участника userId. */
  onScreenStream: (userId: number, stream: MediaStream) => void
  /** Демонстрация экрана участника userId завершилась. */
  onScreenRemoved: (userId: number) => void
  onStatus: (status: SfuStatus) => void
}

interface Pending {
  resolve: (data: any) => void
  reject: (err: Error) => void
}

interface ConsumerMeta {
  userId: number
  source: Source
}

/**
 * Клиент собственного SFU (mediasoup). Держит ОДНО WS-соединение к SFU и один
 * send + один recv WebRTC-транспорт: свой микрофон (и, при желании, экран)
 * уходят Producer'ами, а чужие потоки приходят Consumer'ами. Это заменяет
 * прежний P2P full-mesh (по соединению на каждого участника).
 *
 * Наружу отдаём готовые MediaStream'ы, ключёванные по userId и разведённые по
 * типу: голос (onRemoteStream) и демонстрация экрана (onScreenStream).
 */
export class SfuClient {
  private ws: WebSocket | null = null
  private device = new Device()
  private sendTransport?: types.Transport
  private recvTransport?: types.Transport
  private micProducer?: types.Producer
  private screenProducers: types.Producer[] = []
  private readonly consumers = new Map<string, types.Consumer>()
  private readonly consumerMeta = new Map<string, ConsumerMeta>()
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
        this.micProducer = await this.sendTransport!.produce({
          track: micTrack,
          appData: { source: 'mic' },
        })
      }

      // Подписаться на уже присутствующих участников.
      const producers = (await this.request('getProducers')) as {
        producerId: string
        userId: number
        source: Source
      }[]
      for (const p of producers) await this.consume(p.producerId, p.userId, p.source)
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
        void this.consume(data.producerId, data.userId, data.source ?? 'mic')
        break
      case 'peerClosed':
        this.removeUser(data.userId)
        break
      case 'producerClosed':
        // Конкретный продюсер (например, конец демонстрации) закрылся.
        this.closeConsumersOfProducer(data.producerId)
        break
      case 'consumerClosed': {
        const meta = this.consumerMeta.get(data.consumerId)
        this.consumers.get(data.consumerId)?.close()
        this.consumers.delete(data.consumerId)
        this.consumerMeta.delete(data.consumerId)
        if (meta) this.recomputeStream(meta.userId, meta.source)
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
    // Серверу нужно создать Producer при первом produce() — прокидываем source.
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      this.request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        source: (appData as { source?: string }).source ?? 'mic',
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

  private async consume(producerId: string, userId: number, source: Source) {
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
      const src: Source = (params.source as Source) ?? source
      this.consumers.set(consumer.id, consumer)
      this.consumerMeta.set(consumer.id, { userId: uid, source: src })
      consumer.on('transportclose', () => {
        this.consumers.delete(consumer.id)
        this.consumerMeta.delete(consumer.id)
      })
      // Сервер стартует консюмера на паузе — снимаем после setup.
      await this.request('resumeConsumer', { consumerId: consumer.id })
      this.recomputeStream(uid, src)
    } catch {
      // Один неудавшийся consume не должен ронять весь голос.
    }
  }

  /** Собрать MediaStream пользователя из его действующих консюмеров данного типа. */
  private recomputeStream(userId: number, source: Source) {
    const tracks: MediaStreamTrack[] = []
    for (const [cid, consumer] of this.consumers) {
      const meta = this.consumerMeta.get(cid)
      if (meta && meta.userId === userId && meta.source === source) {
        tracks.push(consumer.track)
      }
    }
    const emitRemoved =
      source === 'screen' ? this.cb.onScreenRemoved : this.cb.onRemoteRemoved
    const emitStream =
      source === 'screen' ? this.cb.onScreenStream : this.cb.onRemoteStream
    if (tracks.length === 0) {
      emitRemoved(userId)
      return
    }
    emitStream(userId, new MediaStream(tracks))
  }

  private closeConsumersOfProducer(producerId: string) {
    const affected: ConsumerMeta[] = []
    for (const [cid, consumer] of this.consumers) {
      if (consumer.producerId === producerId) {
        const meta = this.consumerMeta.get(cid)
        if (meta) affected.push(meta)
        consumer.close()
        this.consumers.delete(cid)
        this.consumerMeta.delete(cid)
      }
    }
    for (const meta of affected) this.recomputeStream(meta.userId, meta.source)
  }

  private removeUser(userId: number) {
    const sources = new Set<Source>()
    for (const [cid, meta] of this.consumerMeta) {
      if (meta.userId === userId) {
        sources.add(meta.source)
        this.consumers.get(cid)?.close()
        this.consumers.delete(cid)
        this.consumerMeta.delete(cid)
      }
    }
    for (const source of sources) this.recomputeStream(userId, source)
  }

  /** Мьют своего микрофона: пауза Producer'а останавливает отправку RTP. */
  setMicPaused(paused: boolean) {
    if (!this.micProducer) return
    if (paused && !this.micProducer.paused) this.micProducer.pause()
    else if (!paused && this.micProducer.paused) this.micProducer.resume()
  }

  /** Начать демонстрацию экрана: продюсим видео (и системный звук, если есть). */
  async startScreen(tracks: MediaStreamTrack[]): Promise<void> {
    if (!this.sendTransport) throw new Error('send transport not ready')
    for (const track of tracks) {
      const producer = await this.sendTransport.produce({
        track,
        appData: { source: 'screen' },
      })
      this.screenProducers.push(producer)
    }
  }

  /** Остановить демонстрацию: закрыть свои screen-продюсеры и уведомить SFU. */
  stopScreen() {
    for (const producer of this.screenProducers) {
      void this.request('closeProducer', { producerId: producer.id }).catch(() => {})
      producer.close()
    }
    this.screenProducers = []
  }

  get sharingScreen(): boolean {
    return this.screenProducers.length > 0
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
    this.consumerMeta.clear()
    this.micProducer?.close()
    for (const p of this.screenProducers) p.close()
    this.screenProducers = []
    this.sendTransport?.close()
    this.recvTransport?.close()
    this.pending.clear()
    this.ws?.close()
    this.ws = null
  }
}
