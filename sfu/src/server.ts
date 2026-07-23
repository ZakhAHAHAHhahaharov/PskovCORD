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

  wss.on('connection', async (ws: WebSocket, req) => {
    let claims: TokenClaims
    try {
      claims = verifyToken(req.url)
    } catch {
      ws.close(4001, 'unauthorized')
      return
    }

    const room = await Rooms.get(String(claims.room))
    const peer = new Peer(Number(claims.uid), ws)
    room.addPeer(peer)
    console.log(`[sfu] peer ${peer.id} (uid=${peer.userId}) joined room ${room.id} (${room.peers.size} in room)`)

    ws.on('message', async (raw) => {
      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      const { id, action, data } = msg
      if (typeof action !== 'string') return
      try {
        const result = await handleRequest(room, peer, action, data)
        peer.send({ id, data: result })
      } catch (err) {
        peer.send({ id, error: (err as Error).message })
      }
    })

    const cleanup = () => {
      if (!room.peers.has(peer.id)) return
      peer.close()
      room.removePeer(peer)
      room.broadcast(peer, 'peerClosed', { userId: peer.userId })
      Rooms.maybeClose(room)
      console.log(`[sfu] peer ${peer.id} (uid=${peer.userId}) left room ${room.id} (${room.peers.size} in room)`)
    }

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  httpServer.listen(config.listenPort, () => {
    console.log(
      `[sfu] listening ws on :${config.listenPort} ` +
        `(announcedIp=${config.announcedIp}, rtc ${config.rtcMinPort}-${config.rtcMaxPort})`,
    )
  })
}
