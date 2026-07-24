import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { VoiceState } from './components/AppShell'
import { SfuClient } from './sfu'
import { playDisconnectSound, playReconnectedSound } from './sounds'

interface VoiceGateway {
  voiceMuteUpdate: (muted: boolean, deafened: boolean) => void
  voiceScreenShareUpdate: (sharing: boolean) => void
}

/**
 * 'reconnecting' — отдельно от 'connecting': сеанс уже был установлен, связь
 * оборвалась, и мы молча пытаемся восстановить её сами (см. reconnect-цикл
 * ниже), не выкидывая пользователя из канала при кратковременном сбое сети.
 */
export type VoiceStatus = 'connecting' | 'reconnecting' | 'connected' | 'failed'

// Автопереподключение при обрыве после успешного коннекта: пробуем БЕССРОЧНО
// (пока пользователь сам не выйдет из канала), с экспоненциальной паузой между
// попытками до потолка. "Сдаться" здесь означает только первый, ещё ни разу
// не удавшийся коннект (см. handleDropped) — тот по-прежнему быстро отдаёт
// 'failed' наверх, где AppShell выкинет из канала алертом.
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 15000
// Если одна попытка connect() не уложилась в это время — считаем её
// зависшей и обрываем сами, а не ждём вечно. Без этого таймаута единственный
// подвисший запрос (например, race на сервере, из-за которой первое
// сообщение терялось — уже пофикшено, но мало ли) намертво стопорил бы весь
// цикл переподключения: ни новых попыток, ни отказа — тишина навсегда.
const CONNECT_ATTEMPT_TIMEOUT_MS = 12000

export interface VoiceMesh {
  remoteStreams: Map<number, MediaStream>
  /** Демонстрации ДРУГИХ, которые мы сейчас активно смотрим (после watchScreen). */
  screenShares: Map<number, MediaStream>
  /** userId'ы, чья демонстрация сейчас доступна для просмотра в этой SFU-комнате
   * (не значит, что мы её смотрим — только что можно нажать «Смотреть»). */
  availableScreenUserIds: Set<number>
  /** Начать смотреть демонстрацию userId (явное действие — автопросмотра нет). */
  watchScreen: (userId: number) => void
  /** Перестать смотреть — сама демонстрация для остальных продолжается. */
  unwatchScreen: (userId: number) => void
  /** Локальный предпросмотр своей демонстрации (без похода через SFU). */
  ownScreenStream: MediaStream | null
  /** Демонстрирую ли я сейчас свой экран. */
  isSharingScreen: boolean
  toggleScreenShare: () => void
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
  screenShares: new Map(),
  availableScreenUserIds: new Set(),
  watchScreen: () => {},
  unwatchScreen: () => {},
  ownScreenStream: null,
  isSharingScreen: false,
  toggleScreenShare: () => {},
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
 * контракт VoiceMesh (remoteStreams по userId, мьют/дефен, пинг, VAD,
 * демонстрация экрана) — см. [[sfu.ts]].
 */
export function useVoiceMesh(
  voice: VoiceState | null,
  gateway: VoiceGateway,
  selfUserId: number | null,
): VoiceMesh {
  const [remoteStreams, setRemoteStreams] = useState<Map<number, MediaStream>>(
    new Map(),
  )
  const [screenShares, setScreenShares] = useState<Map<number, MediaStream>>(
    new Map(),
  )
  const [availableScreenUserIds, setAvailableScreenUserIds] = useState<Set<number>>(
    new Set(),
  )
  const [ownScreenStream, setOwnScreenStream] = useState<MediaStream | null>(null)
  const [isSharingScreen, setIsSharingScreen] = useState(false)
  const [muted, setMuted] = useState(true)
  const [deafened, setDeafened] = useState(false)
  // Честный статус — по факту установленного WebRTC-транспорта к SFU.
  const [status, setStatus] = useState<VoiceStatus>('connecting')
  const [pingMs, setPingMs] = useState<number | null>(null)
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<number>>(new Set())
  const client = useRef<SfuClient | null>(null)
  const localStream = useRef<MediaStream | null>(null)
  // Локальный поток захвата экрана — чтобы остановить его дорожки при завершении.
  const displayStream = useRef<MediaStream | null>(null)
  const remoteStreamsRef = useRef(remoteStreams)
  remoteStreamsRef.current = remoteStreams
  // Состояние мьюта на момент включения дефена — чтобы при выключении дефена
  // вернуть именно его, а не всегда размьючивать.
  const mutedBeforeDeafen = useRef(false)
  // Текущий мьют для переприменения к продюсеру нового SfuClient при
  // автопереподключении (эффект ниже создаётся один раз на весь канал).
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  // То же самое для демонстрации экрана: сам захват (displayStream) не
  // прерывается обрывом связи, только его продюсер на старом (упавшем)
  // SfuClient — на новом транспорте после реконнекта продюсим те же треки
  // заново, чтобы показ не пришлось запускать вручную повторно.
  const isSharingScreenRef = useRef(isSharingScreen)
  isSharingScreenRef.current = isSharingScreen

  useEffect(() => {
    if (!voice) return

    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let hasConnectedOnce = false
    setStatus('connecting')

    const startAttempt = () => {
      if (cancelled) return
      const isReconnect = hasConnectedOnce

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
        onScreenAvailable: (userId) => {
          setAvailableScreenUserIds((prev) => {
            if (prev.has(userId)) return prev
            const next = new Set(prev)
            next.add(userId)
            return next
          })
        },
        onScreenUnavailable: (userId) => {
          setAvailableScreenUserIds((prev) => {
            if (!prev.has(userId)) return prev
            const next = new Set(prev)
            next.delete(userId)
            return next
          })
        },
        onScreenStream: (userId, stream) => {
          setScreenShares((prev) => {
            const next = new Map(prev)
            next.set(userId, stream)
            return next
          })
        },
        onScreenRemoved: (userId) => {
          setScreenShares((prev) => {
            if (!prev.has(userId)) return prev
            const next = new Map(prev)
            next.delete(userId)
            return next
          })
        },
        onStatus: (s) => {
          if (cancelled) return
          if (s === 'connected') {
            // Различаем "просто зашли" и "восстановились после обрыва" —
            // только во втором случае это радостное событие, о котором
            // стоит сигналить звуком.
            if (isReconnect && reconnectAttempt > 0) playReconnectedSound()
            hasConnectedOnce = true
            reconnectAttempt = 0
            setStatus('connected')
          } else if (s === 'connecting') {
            setStatus(isReconnect ? 'reconnecting' : 'connecting')
          } else if (s === 'failed') {
            handleDropped()
          }
        },
      })
      client.current = sfu

      // Сторожевой таймер на саму попытку: если connect() завис (не
      // резолвится и не реджектится — например, из-за потерянного ICE или
      // любой другой безответной подвисшей стадии рукопожатия), сами обрываем
      // эту попытку и уходим в следующую, а не ждём бесконечно. Гонки с
      // onStatus('failed'), который клиент мог прислать сам чуть раньше, нет:
      // handleDropped зовётся не более одного раза на реальный обрыв — либо
      // отсюда, либо оттуда, проверка client.current === sfu не даст сделать
      // это дважды на одну и ту же (уже сменившуюся) попытку.
      let timedOut = false
      const attemptTimeout = setTimeout(() => {
        timedOut = true
        if (client.current === sfu) handleDropped()
      }, CONNECT_ATTEMPT_TIMEOUT_MS)

      void (async () => {
        try {
          await sfu.connect(localStream.current?.getAudioTracks()[0] ?? null)
          clearTimeout(attemptTimeout)
          if (timedOut) return
        } catch {
          // onStatus('failed') уже отправлен клиентом (обычный путь) — либо,
          // если сюда попали из-за attemptTimeout, handleDropped уже вызван там.
          clearTimeout(attemptTimeout)
          return
        }
        // На новом продюсере переприменяем текущий мьют — сам трек уже молчит,
        // если muted (t.enabled=false), но пауза продюсера была локальной для
        // старого (упавшего) SfuClient. Только для переподключения: на самом
        // первом коннекте mutedRef ещё не синхронизирован с состоянием (гонка
        // с getUserMedia), да и не нужен — свежий продюсер и так стартует в
        // консистентном unpaused-состоянии.
        if (isReconnect) sfu.setMicPaused(mutedRef.current)
        // Демонстрация экрана точно так же не должна прерываться реконнектом:
        // захват (displayStream) всё ещё жив, продюсируем его заново на новом
        // транспорте — как будто ничего не было. Голос к этому моменту уже
        // поднят, так что неудача здесь не должна ронять reconnect — просто
        // не поднимаем показ и снимаем "sharing", включат заново вручную.
        if (isReconnect && isSharingScreenRef.current && displayStream.current) {
          try {
            await sfu.startScreen(displayStream.current.getTracks())
          } catch {
            setIsSharingScreen(false)
          }
        }
      })()
    }

    // Связь оборвалась после того, как мы уже были подключены — пробуем
    // автоматически восстановить её сами, не выкидывая из канала за
    // секундный сбой сети. Пока не выйдем из канала сами — пробуем бессрочно
    // (см. константы выше); "сдаёмся" только если не удалось подключиться ни
    // разу — это другой случай, тут retry-цикл ещё не запускался.
    const handleDropped = () => {
      if (cancelled) return
      client.current?.close()
      if (!hasConnectedOnce) {
        setStatus('failed')
        return
      }
      if (reconnectAttempt === 0) playDisconnectSound()
      reconnectAttempt++
      setStatus('reconnecting')
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      reconnectTimer = setTimeout(startAttempt, delay)
    }

    void (async () => {
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
      if (cancelled) return
      startAttempt()
    })()

    // Опрос RTT до SFU раз в 2.5с.
    const pingInterval = setInterval(async () => {
      const rtt = (await client.current?.pingMs()) ?? null
      if (!cancelled) setPingMs(rtt)
    }, 2500)

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(pingInterval)
      client.current?.close()
      client.current = null
      localStream.current?.getTracks().forEach((t) => t.stop())
      localStream.current = null
      displayStream.current?.getTracks().forEach((t) => t.stop())
      displayStream.current = null
      mutedBeforeDeafen.current = false
      setMuted(true)
      setDeafened(false)
      setIsSharingScreen(false)
      setOwnScreenStream(null)
      setStatus('connecting')
      setPingMs(null)
      setRemoteStreams(new Map())
      setScreenShares(new Map())
      setAvailableScreenUserIds(new Set())
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

  // Рассылаем факт демонстрации экрана — виден всем на сервере (не только
  // участникам этого голосового канала), на нём держится бейдж «демка».
  useEffect(() => {
    if (!voice) return
    gateway.voiceScreenShareUpdate(isSharingScreen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.channel.id, isSharingScreen])

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

  const stopSharing = () => {
    client.current?.stopScreen()
    displayStream.current?.getTracks().forEach((t) => t.stop())
    displayStream.current = null
    setIsSharingScreen(false)
    setOwnScreenStream(null)
  }

  const toggleScreenShare = () => {
    if (isSharingScreen) {
      stopSharing()
      return
    }
    if (!client.current) return
    // Системный звук берём вместе с картинкой, если браузер даёт (вкладка/экран).
    void navigator.mediaDevices
      .getDisplayMedia({ video: true, audio: true })
      .then(async (stream) => {
        displayStream.current = stream
        // Пользователь может остановить показ нативной кнопкой браузера —
        // ловим конец видеодорожки и синхронизируем состояние.
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) videoTrack.addEventListener('ended', stopSharing)
        await client.current!.startScreen(stream.getTracks())
        setIsSharingScreen(true)
        setOwnScreenStream(stream)
      })
      .catch(() => {
        // Пользователь отменил выбор экрана — ничего не делаем.
        displayStream.current = null
      })
  }

  const watchScreen = (userId: number) => {
    client.current?.watchScreen(userId)
  }

  const unwatchScreen = (userId: number) => {
    client.current?.unwatchScreen(userId)
  }

  return {
    remoteStreams,
    screenShares,
    availableScreenUserIds,
    watchScreen,
    unwatchScreen,
    ownScreenStream,
    isSharingScreen,
    toggleScreenShare,
    muted,
    toggleMute,
    deafened,
    toggleDeafen,
    status,
    pingMs,
    speakingUserIds,
  }
}
