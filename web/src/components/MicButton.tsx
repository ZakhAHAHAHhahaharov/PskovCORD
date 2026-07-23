import { useVoice } from '../voice'
import { playToggleSound } from '../sounds'

/** Реальная кнопка микрофона — работает только внутри VoiceProvider (когда в голосе). */
export default function MicButton() {
  const { muted, toggleMute } = useVoice()
  const handleClick = () => {
    playToggleSound(muted) // muted=true => сейчас включаем микрофон обратно
    toggleMute()
  }
  return (
    <button
      className={`icon-btn ${muted ? 'muted' : ''}`}
      onClick={handleClick}
      title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
    >
      {muted ? '🔇' : '🎙️'}
    </button>
  )
}
