import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { VoiceState } from './components/AppShell'
import { SfuClient, SfuStatus } from './sfu'

interface VoiceGateway {
  voiceMuteUpdate: (muted: boolean, deafened: boolean) => void
}

export type VoiceStatus = SfuStatus

export interface VoiceMesh {
  remoteStreams: Map<number, MediaStream>
  muted: boolean
  toggleMute: () => void
  deafened: boolean
  toggleDeafen: () => void
  status: VoiceStatus
  /** Средний RTT (мс) до SFU, null пока нет данных. */
  pingMs: number | null
  speakingUserIds: Set<number>
}

const EMPTY_MESH: VoiceMesh = {
  remoteStreams: new Map(),
  muted: true,
  toggleMute: () => {},
  deafened: false,
  toggleDeafen: () => {},
  status: 'connecting',
  pingMs: null,
  speakingUserIds: new Set(),
}

// Простой RMS-детектор активности голоса по реальному аудио-потоку (свой
// микрофон + все remote-треки уже есть локально — сигналить о "говорю" через
// сеть не нужно). HANGOVER сглаживает мигание кольца в паузах между словами.
const SPEAKING_THRESHOLD = 0.035
const SPEAKING_HANGOVER_MS = 300

export const VoiceMeshCtx = createContext<VoiceMesh>(EMPTY_MESH)
export const useVoice = () => useContext(VoiceMeshCtx)

/**
 * Голос через собственный SFU (mediasoup): одно WS-соединение и один
 * send/recv WebRTC-транспорт к SFU-серверу вместо P2P-mesh. Наружу отдаётся
 * тот же контракт VoiceMesh (remoteStreams по userId, мьют/дефен, пинг, VAD),
 * поэтому UI-компоненты и детектор речи не изменились — см. [[sfu.ts]].
 */
export function useVoiceMesh(
  voice: VoiceState | null,
  gateway: VoiceGateway,
  selfUserId: number | null,
): VoiceMesh {
  const [remoteStreams, setRemoteStreams] = useState<Map<number, MediaStream>>(
    new Map(),
  )
  const [muted, setMuted] = useState(true)
  const [deafened, setDeafened] = useState(false)
  // Честный статус — по факту установленного WebRTC-транспорта к SFU.
  const [status, setStatus] = useState<VoiceStatus>('connecting')
  const [pingMs, setPingMs] = useState<number | null>(null)
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<number>>(new Set())
  const client = useRef<SfuClient | null>(null)
  const localStream = useRef<MediaStream | null>(null)
  const remoteStreamsRef = useRef(remoteStreams)
  remoteStreamsRef.current = remoteStreams
  // Состояние мьюта на момент включения дефена — чтобы при выключении дефена
  // вернуть именно его, а не всегда размьючивать.
  const mutedBeforeDeafen = useRef(false)

  useEffect(() => {
    if (!voice) return

    let cancelled = false
    setStatus('connecting')

    const sfu = new SfuClient(voice.sfuUrl, voice.sfuToken, {
      onRemoteStream: (userId, stream) => {
        setRemoteStreams((prev) => {
          const next = new Map(prev)
          next.set(userId, stream)
          return next
        })
      },
      onRemoteRemoved: (userId) => {
        setRemoteStreams((prev) => {
          if (!prev.has(userId)) return prev
          const next = new Map(prev)
          next.delete(userId)
          return next
        })
      },
      onStatus: (s) => {
        if (!cancelled) setStatus(s)
      },
    })
    client.current = sfu

    void (async () => {
      let micTrack: MediaStreamTrack | null = null
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        localStream.current = stream
        micTrack = stream.getAudioTracks()[0] ?? null
        setMuted(false)
      } catch {
        if (!cancelled) setMuted(true)
      }
      if (cancelled) return
      try {
        await sfu.connect(micTrack)
      } catch {
        // onStatus('failed') уже отправлен клиентом.
      }
    })()

    // Опрос RTT до SFU раз в 2.5с.
    const pingInterval = setInterval(async () => {
      const rtt = await sfu.pingMs()
      if (!cancelled) setPingMs(rtt)
    }, 2500)

    return () => {
      cancelled = true
      clearInterval(pingInterval)
      sfu.close()
      client.current = null
      localStream.current?.getTracks().forEach((t) => t.stop())
      localStream.current = null
      mutedBeforeDeafen.current = false
      setMuted(true)
      setDeafened(false)
      setStatus('connecting')
      setPingMs(null)
      setRemoteStreams(new Map())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.channel.id])

  // Рассылаем свой статус мьюта/дефена остальным участникам канала — им
  // нужно рисовать значок у себя, а не только знать о самом факте.
  useEffect(() => {
    if (!voice) return
    gateway.voiceMuteUpdate(muted, deafened)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.channel.id, muted, deafened])

  // VAD: анализируем реальные аудио-потоки (свой + remote), которые уже текут
  // через WebRTC, вместо того чтобы гонять "speaking"-события через сеть.
  useEffect(() => {
    if (!voice) return

    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext
    if (!AudioCtx) return
    const audioCtx: AudioContext = new AudioCtx()
    const analysers = new Map<
      number,
      { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }
    >()
    const lastLoudAt = new Map<number, number>()
    let rafId: number
    let cancelled = false

    const ensureAnalyser = (userId: number, stream: MediaStream) => {
      if (analysers.has(userId)) return
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      analysers.set(userId, {
        analyser,
        data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      })
    }

    const tick = () => {
      if (cancelled) return

      const active: [number, MediaStream][] = []
      if (localStream.current && selfUserId != null) {
        active.push([selfUserId, localStream.current])
      }
      for (const entry of remoteStreamsRef.current) active.push(entry)

      for (const [userId, stream] of active) ensureAnalyser(userId, stream)
      for (const userId of Array.from(analysers.keys())) {
        if (!active.some(([id]) => id === userId)) analysers.delete(userId)
      }

      const now = performance.now()
      for (const [userId, { analyser, data }] of analysers) {
        analyser.getByteTimeDomainData(data)
        let sumSquares = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sumSquares += v * v
        }
        if (Math.sqrt(sumSquares / data.length) > SPEAKING_THRESHOLD) {
          lastLoudAt.set(userId, now)
        }
      }

      setSpeakingUserIds((prev) => {
        const next = new Set<number>()
        for (const [userId, t] of lastLoudAt) {
          if (now - t < SPEAKING_HANGOVER_MS) next.add(userId)
        }
        if (next.size === prev.size && Array.from(next).every((id) => prev.has(id))) {
          return prev
        }
        return next
      })

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      audioCtx.close().catch(() => {})
    }
  }, [voice?.channel.id, selfUserId])

  const toggleMute = () => {
    if (!localStream.current) return
    const enabled = localStream.current.getAudioTracks().some((t) => t.enabled)
    localStream.current.getAudioTracks().forEach((t) => (t.enabled = !enabled))
    // enabled=true => сейчас размьючены, значит мьютим => пауза продюсера.
    client.current?.setMicPaused(enabled)
    setMuted(enabled)
    // Как в Discord: включение микрофона автоматически снимает дефен.
    if (!enabled && deafened) setDeafened(false)
  }

  const toggleDeafen = () => {
    setDeafened((prev) => {
      const next = !prev
      if (next) {
        // Дефен глушит и свой микрофон — иначе странно "не слышать", но
        // говорить. Запоминаем прежнее состояние мьюта для восстановления.
        mutedBeforeDeafen.current = muted
        localStream.current?.getAudioTracks().forEach((t) => (t.enabled = false))
        client.current?.setMicPaused(true)
        setMuted(true)
      } else {
        // Возвращаем микрофон в состояние до дефена.
        const restoreMuted = mutedBeforeDeafen.current
        localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !restoreMuted))
        client.current?.setMicPaused(restoreMuted)
        setMuted(restoreMuted)
      }
      return next
    })
  }

  return {
    remoteStreams,
    muted,
    toggleMute,
    deafened,
    toggleDeafen,
    status,
    pingMs,
    speakingUserIds,
  }
}
