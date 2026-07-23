import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { VoiceState } from './components/AppShell'

interface VoiceGateway {
  on: (op: string, handler: (payload: any) => void) => () => void
  voiceOffer: (toUserId: number, sdp: string) => void
  voiceAnswer: (toUserId: number, sdp: string) => void
  voiceIceCandidate: (toUserId: number, candidate: RTCIceCandidateInit) => void
}

interface Peer {
  pc: RTCPeerConnection
  pendingCandidates: RTCIceCandidateInit[]
}

export type VoiceStatus = 'connecting' | 'connected' | 'failed'

export interface VoiceMesh {
  remoteStreams: Map<number, MediaStream>
  muted: boolean
  toggleMute: () => void
  status: VoiceStatus
}

const EMPTY_MESH: VoiceMesh = {
  remoteStreams: new Map(),
  muted: true,
  toggleMute: () => {},
  status: 'connecting',
}

export const VoiceMeshCtx = createContext<VoiceMesh>(EMPTY_MESH)
export const useVoice = () => useContext(VoiceMeshCtx)

/**
 * WebRTC P2P mesh: по одному RTCPeerConnection на каждого другого участника
 * голосового канала. Новый участник (тот, кто получил voice_peers) всегда
 * инициирует offer; остальные только отвечают — так не бывает glare для
 * audio-only сценария и не нужен perfect-negotiation.
 */
export function useVoiceMesh(
  voice: VoiceState | null,
  gateway: VoiceGateway,
): VoiceMesh {
  const [remoteStreams, setRemoteStreams] = useState<Map<number, MediaStream>>(
    new Map(),
  )
  const [muted, setMuted] = useState(true)
  // Честный статус — не "подключено" сразу после join, а по факту хотя бы
  // одного реально установленного RTCPeerConnection (или отсутствия пиров).
  const [status, setStatus] = useState<VoiceStatus>('connecting')
  const peers = useRef<Map<number, Peer>>(new Map())
  const localStream = useRef<MediaStream | null>(null)

  const evaluateStatus = () => {
    const states = Array.from(peers.current.values()).map((p) => p.pc.connectionState)
    if (states.some((s) => s === 'connected')) {
      setStatus('connected')
    } else if (states.length > 0 && states.every((s) => s === 'failed' || s === 'closed')) {
      setStatus('failed')
    }
  }

  const closePeer = (userId: number) => {
    const peer = peers.current.get(userId)
    if (!peer) return
    peer.pc.close()
    peers.current.delete(userId)
    setRemoteStreams((prev) => {
      if (!prev.has(userId)) return prev
      const next = new Map(prev)
      next.delete(userId)
      return next
    })
  }

  const ensurePeer = (userId: number): Peer => {
    let peer = peers.current.get(userId)
    if (peer) return peer
    const pc = new RTCPeerConnection({ iceServers: voice?.iceServers ?? [] })
    if (localStream.current) {
      localStream.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStream.current!))
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) gateway.voiceIceCandidate(userId, e.candidate.toJSON())
    }
    pc.onconnectionstatechange = evaluateStatus
    pc.ontrack = (e) => {
      setRemoteStreams((prev) => {
        const next = new Map(prev)
        next.set(userId, e.streams[0])
        return next
      })
    }
    peer = { pc, pendingCandidates: [] }
    peers.current.set(userId, peer)
    return peer
  }

  const flushCandidates = async (peer: Peer) => {
    const pending = peer.pendingCandidates
    peer.pendingCandidates = []
    for (const c of pending) {
      await peer.pc.addIceCandidate(c).catch(() => {})
    }
  }

  useEffect(() => {
    if (!voice) return

    let cancelled = false
    const channelId = voice.channel.id
    setStatus('connecting')

    const micReady = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        localStream.current = stream
        setMuted(false)
      } catch {
        if (!cancelled) setMuted(true)
      }
    })()

    const offPeers = gateway.on('voice_peers', async (d) => {
      if (d.channel_id !== channelId) return
      await micReady
      if (cancelled) return
      const peerIds = d.peer_ids as number[]
      if (peerIds.length === 0) setStatus('connected') // некого ждать
      for (const peerId of peerIds) {
        const peer = ensurePeer(peerId)
        const offer = await peer.pc.createOffer()
        await peer.pc.setLocalDescription(offer)
        gateway.voiceOffer(peerId, offer.sdp!)
      }
    })

    const offOffer = gateway.on('voice_offer', async (d) => {
      await micReady
      if (cancelled) return
      const peer = ensurePeer(d.from_user_id)
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp })
      await flushCandidates(peer)
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      gateway.voiceAnswer(d.from_user_id, answer.sdp!)
    })

    const offAnswer = gateway.on('voice_answer', async (d) => {
      const peer = peers.current.get(d.from_user_id)
      if (!peer) return
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp })
      await flushCandidates(peer)
    })

    const offIce = gateway.on('voice_ice_candidate', (d) => {
      const peer = peers.current.get(d.from_user_id)
      if (!peer) return
      if (peer.pc.remoteDescription) {
        peer.pc.addIceCandidate(d.candidate).catch(() => {})
      } else {
        peer.pendingCandidates.push(d.candidate)
      }
    })

    const offState = gateway.on('voice_state_update', (d) => {
      if (d.channel_id === channelId) return
      if (peers.current.has(d.user_id)) closePeer(d.user_id)
    })

    return () => {
      cancelled = true
      offPeers()
      offOffer()
      offAnswer()
      offIce()
      offState()
      for (const userId of Array.from(peers.current.keys())) closePeer(userId)
      localStream.current?.getTracks().forEach((t) => t.stop())
      localStream.current = null
      setMuted(true)
      setStatus('connecting')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.channel.id])

  const toggleMute = () => {
    if (!localStream.current) return
    const enabled = localStream.current.getAudioTracks().some((t) => t.enabled)
    localStream.current.getAudioTracks().forEach((t) => (t.enabled = !enabled))
    setMuted(enabled)
  }

  return { remoteStreams, muted, toggleMute, status }
}
