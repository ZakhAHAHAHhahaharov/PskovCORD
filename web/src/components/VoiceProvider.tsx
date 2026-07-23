import { ReactNode, useEffect } from 'react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
} from '@livekit/components-react'
import { ConnectionState } from 'livekit-client'
import { VoiceState } from './AppShell'

export type VoiceStatus = 'connecting' | 'connected' | 'failed'

/**
 * Пытается включить микрофон ПОСЛЕ подключения к комнате.
 * Если мик запрещён/недоступен — остаёмся в канале «замьюченными»
 * (как в Discord), а не вылетаем.
 */
function AutoMic() {
  const { localParticipant } = useLocalParticipant()
  useEffect(() => {
    localParticipant.setMicrophoneEnabled(true).catch(() => {
      /* нет доступа к микрофону — тихо остаёмся без звука */
    })
  }, [localParticipant])
  return null
}

/** Сообщает наружу реальное состояние WebRTC-соединения (не оптимистичное). */
function ConnectionWatcher({
  onStatus,
}: {
  onStatus: (s: VoiceStatus) => void
}) {
  const state = useConnectionState()
  useEffect(() => {
    if (state === ConnectionState.Connected) onStatus('connected')
    else if (state === ConnectionState.Disconnected) onStatus('failed')
    else onStatus('connecting')
  }, [state, onStatus])
  return null
}

export default function VoiceProvider({
  voice,
  onLeave,
  onStatus,
  children,
}: {
  voice: VoiceState | null
  onLeave: () => void
  onStatus: (s: VoiceStatus) => void
  children: ReactNode
}) {
  if (!voice) return <>{children}</>
  return (
    <LiveKitRoom
      serverUrl={voice.url}
      token={voice.token}
      connect
      // Не запрашиваем мик на этапе connect — иначе отказ в доступе рвёт вход.
      audio={false}
      video={false}
      onDisconnected={onLeave}
      onError={(e) => {
        console.error('LiveKit connection error:', e)
        onStatus('failed')
      }}
    >
      <ConnectionWatcher onStatus={onStatus} />
      <RoomAudioRenderer />
      <AutoMic />
      {children}
    </LiveKitRoom>
  )
}
