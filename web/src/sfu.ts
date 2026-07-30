import { Device } from 'mediasoup-client'
import type { types } from 'mediasoup-client'

export type SfuStatus = 'connecting' | 'connected' | 'failed'

/** Тип потока: голос (микрофон) или демонстрация экрана. */
type Source = 'mic' | 'screen'

export interface SfuCallbacks {
  /** Появился/обновился голосовой поток участника userId. Голос всегда
   * автослушается — в отличие от демонстрации экрана. */
  onRemoteStream: (userId: number, stream: MediaStream) => void
  /** Голосовой поток участника userId пропал. */
  onRemoteRemoved: (userId: number) => void
  /** userId начал демонстрировать экран (в этой SFU-комнате появился
   * producer источника screen) — ещё НЕ значит, что мы его смотрим. */
  onScreenAvailable: (userId: number) => void
  /** userId перестал демонстрировать экран (все screen-продюсеры закрыты). */
  onScreenUnavailable: (userId: number) => void
  /** Появился/обновился АКТИВНО ПРОСМАТРИВАЕМЫЙ поток демонстрации userId
   * (после watchScreen). */
  onScreenStream: (userId: number, stream: MediaStream) => void
  /** Просматриваемый поток демонстрации userId пропал (после unwatchScreen
   * или из-за того, что демонстрация вообще завершилась). */
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
 * send + один recv WebRTC-транспорт: свой микрофон (и, при демонстрации,
 * экран) уходят Producer'ами, а чужие потоки приходят Consumer'ами. Это
 * заменяет прежний P2P full-mesh (по соединению на каждого участника).
 *
 * Голос слушается автоматически (как и раньше). Демонстрация экрана — НЕТ:
 * SFU лишь сообщает, что у userId появился screen-producer (доступен для
 * просмотра); реальный consume() запускается только явным watchScreen(),
 * чтобы зайти в комнату не значило автоматически смотреть чей-то экран.
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
  // Доступные (но не обязательно просматриваемые) screen-продюсеры по userId —
  // нужны, чтобы watchScreen() знал, что именно consume'ить.
  private readonly availableScreenProducers = new Map<number, Set<string>>()
  private readonly watchedScreenUsers = new Set<number>()
  private readonly pending = new Map<number, Pending>()
  // producerId'ы, на которые consume() уже запущен, но ещё не завершился —
  // без этого набора параллельный вызов consumeMic/consumeScreen для того же
  // producerId (например, он уже был в снимке getProducers() при connect(),
  // и тут же прилетело живое newProducer-уведомление на него же) запускал
  // recvTransport.consume() дважды одновременно. Второй вызов ломал SDP
  // recv-транспорта (несовпадение числа m-line у транссиверов) и Chrome
  // ронял вкладку с DOMException "Index or size is negative or greater than
  // the allowed amount" — воспроизводилось именно при входе в канал, где уже
  // есть другой участник.
  private readonly consumingProducerIds = new Set<string>()
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

      // Подписаться на уже присутствующих участников: голос — сразу, экран —
      // только зафиксировать доступность (см. класс-докстринг).
      const producers = (await this.request('getProducers')) as {
        producerId: string
        userId: number
        source: Source
      }[]
      for (const p of producers) {
        if (p.source === 'screen') this.markScreenAvailable(p.userId, p.producerId)
        else await this.consumeMic(p.producerId, p.userId)
      }
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
      let settled = false
      ws.onopen = () => {
        settled = true
        resolve()
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        reject(new Error('SFU WebSocket error'))
      }
      ws.onclose = () => {
        // Сервер может закрыть соединение уже ПОСЛЕ успешного хендшейка —
        // ровно так выглядит отказ по токену (close(4001, 'unauthorized')).
        // Браузер в этом случае шлёт onclose без onerror, и раньше промис
        // openSocket() не резолвился и не реджектился НИКОГДА: connect()
        // висел вечно, а спасал только сторожевой таймер в voice.ts.
        if (!settled) {
          settled = true
          reject(new Error('SFU WebSocket closed before open'))
        }
        this.rejectPending(new Error('SFU socket closed'))
        if (!this.closed) this.cb.onStatus('failed')
      }
      ws.onmessage = (e) => this.onMessage(e.data)
    })
  }

  /** Оборвать все запросы, ждущие ответа. Без этого они висели бы вечно:
   * request() не ставит таймаут, а close() раньше просто чистил Map, никого
   * не оповестив — любой await на таком запросе не завершался ни успехом,
   * ни ошибкой. */
  private rejectPending(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
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
        if (data.source === 'screen') {
          this.markScreenAvailable(data.userId, data.producerId)
          // Если этого пользователя уже смотрят (например, у демонстрации
          // видео и звук приходят двумя producer'ами не одновременно) —
          // сразу подхватываем новый трек в уже идущий просмотр.
          if (this.watchedScreenUsers.has(data.userId)) {
            void this.consumeScreen(data.producerId, data.userId)
          }
        } else {
          void this.consumeMic(data.producerId, data.userId)
        }
        break
      case 'peerClosed':
        this.removeUser(data.userId)
        break
      case 'producerClosed':
        this.onProducerClosed(data.producerId, data.userId, data.source)
        break
      case 'consumerClosed': {
        const meta = this.consumerMeta.get(data.consumerId)
        this.consumers.get(data.consumerId)?.close()
        this.consumers.delete(data.consumerId)
        this.consumerMeta.delete(data.consumerId)
        if (meta?.source === 'mic') this.recomputeMicStream(meta.userId)
        else if (meta) this.recomputeScreenStream(meta.userId)
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

  private markScreenAvailable(userId: number, producerId: string) {
    let set = this.availableScreenProducers.get(userId)
    const wasAvailable = !!set && set.size > 0
    if (!set) {
      set = new Set()
      this.availableScreenProducers.set(userId, set)
    }
    set.add(producerId)
    if (!wasAvailable) this.cb.onScreenAvailable(userId)
  }

  private onProducerClosed(producerId: string, userId: number, source: Source) {
    if (source !== 'screen') return
    const set = this.availableScreenProducers.get(userId)
    set?.delete(producerId)
    // Если этот producer сейчас смотрели — закрыть его consumer и пересчитать.
    for (const [cid, consumer] of this.consumers) {
      if (consumer.producerId === producerId) {
        consumer.close()
        this.consumers.delete(cid)
        this.consumerMeta.delete(cid)
      }
    }
    if (!set || set.size === 0) {
      this.availableScreenProducers.delete(userId)
      this.cb.onScreenUnavailable(userId)
      if (this.watchedScreenUsers.has(userId)) {
        this.watchedScreenUsers.delete(userId)
        this.cb.onScreenRemoved(userId)
      }
    } else if (this.watchedScreenUsers.has(userId)) {
      this.recomputeScreenStream(userId)
    }
  }

  private async consumeMic(producerId: string, userId: number) {
    if (this.closed || !this.recvTransport) return
    if (this.isAlreadyConsuming(producerId)) return
    this.consumingProducerIds.add(producerId)
    try {
      const consumer = await this.doConsume(producerId)
      this.consumers.set(consumer.id, consumer)
      this.consumerMeta.set(consumer.id, { userId, source: 'mic' })
      consumer.on('transportclose', () => {
        this.consumers.delete(consumer.id)
        this.consumerMeta.delete(consumer.id)
      })
      await this.request('resumeConsumer', { consumerId: consumer.id })
      this.recomputeMicStream(userId)
    } catch {
      // Один неудавшийся consume не должен ронять весь голос.
    } finally {
      this.consumingProducerIds.delete(producerId)
    }
  }

  /** true, если producerId уже consume'ится (в процессе) или уже consume'ен
   * (есть готовый consumer) — см. комментарий у consumingProducerIds. */
  private isAlreadyConsuming(producerId: string): boolean {
    if (this.consumingProducerIds.has(producerId)) return true
    for (const consumer of this.consumers.values()) {
      if (consumer.producerId === producerId) return true
    }
    return false
  }

  private async consumeScreen(producerId: string, userId: number) {
    if (this.closed || !this.recvTransport) return
    if (this.isAlreadyConsuming(producerId)) return
    this.consumingProducerIds.add(producerId)
    try {
      const consumer = await this.doConsume(producerId)
      this.consumers.set(consumer.id, consumer)
      this.consumerMeta.set(consumer.id, { userId, source: 'screen' })
      consumer.on('transportclose', () => {
        this.consumers.delete(consumer.id)
        this.consumerMeta.delete(consumer.id)
      })
      await this.request('resumeConsumer', { consumerId: consumer.id })
      this.recomputeScreenStream(userId)
    } catch {
      // Не смогли подключить один из треков демонстрации — не фатально.
    } finally {
      this.consumingProducerIds.delete(producerId)
    }
  }

  private async doConsume(producerId: string): Promise<types.Consumer> {
    const params = await this.request('consume', {
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    })
    return this.recvTransport!.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    })
  }

  /** Явно начать просмотр демонстрации экрана userId (по клику «Смотреть»). */
  watchScreen(userId: number): void {
    if (this.watchedScreenUsers.has(userId)) return
    this.watchedScreenUsers.add(userId)
    const producerIds = this.availableScreenProducers.get(userId)
    if (!producerIds || producerIds.size === 0) return
    for (const producerId of producerIds) {
      void this.consumeScreen(producerId, userId)
    }
  }

  /** Прекратить просмотр демонстрации userId (сама демонстрация продолжается
   * для остальных — мы просто перестаём тянуть трафик). */
  unwatchScreen(userId: number): void {
    if (!this.watchedScreenUsers.delete(userId)) return
    for (const [cid, meta] of Array.from(this.consumerMeta)) {
      if (meta.userId === userId && meta.source === 'screen') {
        void this.request('closeConsumer', { consumerId: cid }).catch(() => {})
        this.consumers.get(cid)?.close()
        this.consumers.delete(cid)
        this.consumerMeta.delete(cid)
      }
    }
    this.cb.onScreenRemoved(userId)
  }

  isWatchingScreen(userId: number): boolean {
    return this.watchedScreenUsers.has(userId)
  }

  /** Запретить/разрешить userId смотреть НАШУ демонстрацию экрана — действует
   * на текущее подключение к SFU (см. Peer.blockedScreenViewers на сервере),
   * применяется сразу же к уже идущему показу (сервер сам обрывает его
   * consumer'ы у заблокированного зрителя). */
  blockScreenViewer(userId: number, blocked: boolean): void {
    void this.request('blockScreenViewer', { targetUserId: userId, blocked }).catch(() => {})
  }

  private recomputeMicStream(userId: number) {
    const tracks: MediaStreamTrack[] = []
    for (const [cid, consumer] of this.consumers) {
      const meta = this.consumerMeta.get(cid)
      if (meta && meta.userId === userId && meta.source === 'mic') tracks.push(consumer.track)
    }
    if (tracks.length === 0) {
      this.cb.onRemoteRemoved(userId)
      return
    }
    this.cb.onRemoteStream(userId, new MediaStream(tracks))
  }

  private recomputeScreenStream(userId: number) {
    const tracks: MediaStreamTrack[] = []
    for (const [cid, consumer] of this.consumers) {
      const meta = this.consumerMeta.get(cid)
      if (meta && meta.userId === userId && meta.source === 'screen') tracks.push(consumer.track)
    }
    if (tracks.length === 0) {
      this.cb.onScreenRemoved(userId)
      return
    }
    this.cb.onScreenStream(userId, new MediaStream(tracks))
  }

  private removeUser(userId: number) {
    for (const [cid, meta] of Array.from(this.consumerMeta)) {
      if (meta.userId !== userId) continue
      this.consumers.get(cid)?.close()
      this.consumers.delete(cid)
      this.consumerMeta.delete(cid)
    }
    this.cb.onRemoteRemoved(userId)
    if (this.availableScreenProducers.delete(userId)) {
      this.cb.onScreenUnavailable(userId)
    }
    if (this.watchedScreenUsers.delete(userId)) {
      this.cb.onScreenRemoved(userId)
    }
  }

  /** Мьют своего микрофона: пауза Producer'а останавливает отправку RTP. */
  setMicPaused(paused: boolean) {
    if (!this.micProducer) return
    if (paused && !this.micProducer.paused) this.micProducer.pause()
    else if (!paused && this.micProducer.paused) this.micProducer.resume()
  }

  /** Предъявить свежий access-токен, не переподключаясь.
   *
   * Права роли («Говорить»/«Показывать видео») живут в токене, а он
   * предъявляется один раз — при открытии соединения (см. sfu/src/server.ts).
   * Из-за этого право, снятое и возвращённое обратно, начинало работать
   * только после выхода и повторного входа в канал. */
  async updateToken(token: string): Promise<void> {
    await this.request('updateToken', { token })
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
      // getStats() может отдать НЕСКОЛЬКО candidate-pair репортов (в т.ч.
      // устаревшие, от прошлых ICE-рестартов) — forEach без явного выбора
      // "лучшего" перезаписывал rtt в порядке обхода Map (не гарантирован),
      // из-за чего в итоге мог остаться репорт от неактивной пары. Явно
      // предпочитаем именно nominated — это и есть реально используемая пара.
      let best: any = null
      stats.forEach((report: any) => {
        if (report.type !== 'candidate-pair') return
        if (!report.nominated && report.state !== 'succeeded') return
        if (!best || (report.nominated && !best.nominated)) best = report
      })
      if (!best || typeof best.currentRoundTripTime !== 'number') return null
      // currentRoundTripTimeMeasurements === 0 значит ни одной STUN-проверки
      // живости ещё не прошло — currentRoundTripTime в этот момент застыл на
      // 0 не потому что пинг реально нулевой, а потому что мерить ещё нечем
      // (отсюда и "всегда 0 мс" сразу после коннекта/реконнекта). Раз в
      // несколько секунд consent-freshness обновит его сама — просто пока не
      // показываем ложный ноль.
      if (best.currentRoundTripTimeMeasurements === 0) return null
      return best.currentRoundTripTime * 1000
    } catch {
      return null
    }
  }

  close() {
    this.closed = true
    for (const c of this.consumers.values()) c.close()
    this.consumers.clear()
    this.consumerMeta.clear()
    this.consumingProducerIds.clear()
    this.availableScreenProducers.clear()
    this.watchedScreenUsers.clear()
    this.micProducer?.close()
    for (const p of this.screenProducers) p.close()
    this.screenProducers = []
    this.sendTransport?.close()
    this.recvTransport?.close()
    this.rejectPending(new Error('SFU client closed'))
    this.ws?.close()
    this.ws = null
  }
}
