import { ReactNode, useEffect } from 'react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
} from '@livekit/components-react'
import { VoiceState } from './AppShell'

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

export default function VoiceProvider({
  voice,
  onLeave,
  children,
}: {
  voice: VoiceState | null
  onLeave: () => void
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
    >
      <RoomAudioRenderer />
      <AutoMic />
      {children}
    </LiveKitRoom>
  )
}
