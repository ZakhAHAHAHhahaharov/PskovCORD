import http from 'http'
import { URL } from 'url'
import { WebSocketServer, WebSocket } from 'ws'
import { config } from './config'
import { TokenClaims, verifyToken } from './auth'
import { Rooms, Peer } from './room'
import { handleRequest } from './signaling'

/** Верификация access-токена из query (?token=...), подписан SFU_SECRET. */
function verifyTokenFromUrl(rawUrl: string | undefined): TokenClaims {
  const url = new URL(rawUrl || '', 'http://localhost')
  return verifyToken(url.searchParams.get('token') || '')
}

export function startServer(): void {
  const httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws: WebSocket, req) => {
    let claims: TokenClaims
    try {
      claims = verifyTokenFromUrl(req.url)
    } catch {
      ws.close(4001, 'unauthorized')
      return
    }

    const peer = new Peer(Number(claims.uid), ws, {
      canSpeak: claims.speak !== false,
      canVideo: claims.video !== false,
    })
    // Комната резолвится асинхронно (первый вход создаёт mediasoup Router),
    // но 'message'/'close' вешаем СРАЗУ и синхронно — если бы мы сначала
    // ждали Rooms.get(), а слушатель добавляли после await, самое первое
    // сообщение клиента (обычно getRouterRtpCapabilities, отправленное сразу
    // по открытию сокета) могло прийти раньше, чем появится listener, и
    // просто терялось бы без ответа — весь хендшейк вис бы до таймаута.
    const roomPromise = Rooms.get(String(claims.room))
    let room: import('./room').Room | undefined
    let joined = false

    const ensureJoined = async () => {
      if (joined) return room!
      room = await roomPromise
      room.addPeer(peer)
      joined = true
      console.log(`[sfu] peer ${peer.id} (uid=${peer.userId}) joined room ${room.id} (${room.peers.size} in room)`)
      return room
    }

    ws.on('message', async (raw) => {
      let r: Awaited<ReturnType<typeof ensureJoined>>
      try {
        r = await ensureJoined()
      } catch (err) {
        // Комнату не удалось создать (упал mediasoup-воркер и т.п.). Раньше
        // reject уходил в никуда: клиент вис без ответа, а необработанный
        // rejection мог утащить за собой весь процесс — вместе с остальными
        // комнатами на этом же SFU.
        console.error(`[sfu] peer ${peer.id}: не удалось войти в комнату:`, err)
        ws.close(1011, 'room unavailable')
        return
      }
      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      const { id, action, data } = msg
      if (typeof action !== 'string') return
      try {
        const result = await handleRequest(r, peer, action, data)
        peer.send({ id, data: result })
      } catch (err) {
        peer.send({ id, error: (err as Error).message })
      }
    })

    const cleanup = async () => {
      const r = await roomPromise.catch(() => undefined)
      if (!r || !r.peers.has(peer.id)) return
      peer.close()
      r.removePeer(peer)
      r.broadcast(peer, 'peerClosed', { userId: peer.userId })
      Rooms.maybeClose(r)
      console.log(`[sfu] peer ${peer.id} (uid=${peer.userId}) left room ${r.id} (${r.peers.size} in room)`)
    }

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  httpServer.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `[sfu] listening ws on ${config.listenHost}:${config.listenPort} ` +
        `(announcedIp=${config.announcedIp}, rtc ${config.rtcMinPort}-${config.rtcMaxPort})`,
    )
  })
}
