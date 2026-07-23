import { useLocalParticipant } from '@livekit/components-react'

/** Реальная кнопка микрофона — работает только внутри LiveKitRoom (когда в голосе). */
export default function MicButton() {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant()
  const toggle = () => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)
  return (
    <button
      className={`icon-btn ${isMicrophoneEnabled ? '' : 'muted'}`}
      onClick={toggle}
      title={isMicrophoneEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
    >
      {isMicrophoneEnabled ? '🎙️' : '🔇'}
    </button>
  )
}
