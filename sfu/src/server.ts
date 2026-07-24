import http from 'http'
import { URL } from 'url'
import { WebSocketServer, WebSocket } from 'ws'
import jwt from 'jsonwebtoken'
import { config } from './config'
import { Rooms, Peer } from './room'
import { handleRequest } from './signaling'

interface TokenClaims {
  uid: number
  room: string
  name?: string
}

/** Верификация access-токена из query (?token=...), подписан SFU_SECRET. */
function verifyToken(rawUrl: string | undefined): TokenClaims {
  const url = new URL(rawUrl || '', 'http://localhost')
  const token = url.searchParams.get('token') || ''
  return jwt.verify(token, config.sfuSecret) as TokenClaims
}

export function startServer(): void {
  const httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws: WebSocket, req) => {
    let claims: TokenClaims
    try {
      claims = verifyToken(req.url)
    } catch {
      ws.close(4001, 'unauthorized')
      return
    }

    const peer = new Peer(Number(claims.uid), ws)
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
      const r = await ensureJoined()
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
