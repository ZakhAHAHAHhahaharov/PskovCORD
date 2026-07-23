import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  ReactNode,
} from 'react'
import { getToken } from './api'

type Handler = (payload: any) => void

interface GatewayCtx {
  on: (op: string, handler: Handler) => () => void
  sendMessage: (channelId: number, content: string) => void
  deleteMessage: (messageId: number) => void
  voiceJoin: (channelId: number) => void
  voiceLeave: () => void
  voiceOffer: (toUserId: number, sdp: string) => void
  voiceAnswer: (toUserId: number, sdp: string) => void
  voiceIceCandidate: (toUserId: number, candidate: RTCIceCandidateInit) => void
  voiceMuteUpdate: (muted: boolean, deafened: boolean) => void
  voiceTopicUpdate: (topic: string) => void
}

const Ctx = createContext<GatewayCtx>(null as unknown as GatewayCtx)
export const useGateway = () => useContext(Ctx)

// Пусто => same-origin (ws/wss от текущего хоста). Для dev задаётся в web/.env.
const ENV_WS = import.meta.env.VITE_WS_URL
const WS: string =
  ENV_WS !== undefined && ENV_WS !== ''
    ? ENV_WS
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

export function GatewayProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlers = useRef<Map<string, Set<Handler>>>(new Map())
  const queue = useRef<string[]>([])
  const closed = useRef(false)

  const connect = useCallback(() => {
    const token = getToken()
    if (!token || closed.current) return

    const ws = new WebSocket(`${WS}/ws/gateway?token=${token}`)
    wsRef.current = ws

    ws.onopen = () => {
      queue.current.forEach((m) => ws.send(m))
      queue.current = []
    }
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        handlers.current.get(data.op)?.forEach((h) => h(data))
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      wsRef.current = null
      if (!closed.current) setTimeout(connect, 2000)
    }
  }, [])

  useEffect(() => {
    closed.current = false
    connect()
    return () => {
      closed.current = true
      wsRef.current?.close()
    }
  }, [connect])

  const raw = (obj: unknown) => {
    const msg = JSON.stringify(obj)
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg)
    else queue.current.push(msg)
  }

  const on = useCallback((op: string, handler: Handler) => {
    if (!handlers.current.has(op)) handlers.current.set(op, new Set())
    handlers.current.get(op)!.add(handler)
    return () => {
      handlers.current.get(op)?.delete(handler)
    }
  }, [])

  const value: GatewayCtx = {
    on,
    sendMessage: (channelId, content) =>
      raw({ op: 'send_message', channel_id: channelId, content }),
    deleteMessage: (messageId) => raw({ op: 'delete_message', message_id: messageId }),
    voiceJoin: (channelId) => raw({ op: 'voice_join', channel_id: channelId }),
    voiceLeave: () => raw({ op: 'voice_leave' }),
    voiceOffer: (toUserId, sdp) =>
      raw({ op: 'voice_offer', to_user_id: toUserId, sdp }),
    voiceAnswer: (toUserId, sdp) =>
      raw({ op: 'voice_answer', to_user_id: toUserId, sdp }),
    voiceIceCandidate: (toUserId, candidate) =>
      raw({ op: 'voice_ice_candidate', to_user_id: toUserId, candidate }),
    voiceMuteUpdate: (muted, deafened) =>
      raw({ op: 'voice_mute_update', muted, deafened }),
    voiceTopicUpdate: (topic) => raw({ op: 'voice_topic_update', topic }),
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
