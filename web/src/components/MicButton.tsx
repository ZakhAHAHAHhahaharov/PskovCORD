import { useVoice } from '../voice'

/** Реальная кнопка микрофона — работает только внутри VoiceProvider (когда в голосе). */
export default function MicButton() {
  const { muted, toggleMute } = useVoice()
  return (
    <button
      className={`icon-btn ${muted ? 'muted' : ''}`}
      onClick={toggleMute}
      title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
    >
      {muted ? '🔇' : '🎙️'}
    </button>
  )
}
