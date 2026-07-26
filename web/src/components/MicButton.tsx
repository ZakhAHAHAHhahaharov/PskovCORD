import { Mic, MicOff } from 'lucide-react'
import { useVoice } from '../voice'
import { playToggleSound } from '../sounds'

/** Реальная кнопка микрофона — работает только внутри VoiceProvider (когда в голосе). */
export default function MicButton() {
  const { muted, toggleMute, forcedMuteUntil } = useVoice()
  const isForcedMuted = forcedMuteUntil != null && Date.now() < forcedMuteUntil * 1000
  const handleClick = () => {
    if (isForcedMuted) return
    playToggleSound(muted) // muted=true => сейчас включаем микрофон обратно
    toggleMute()
  }
  return (
    <button
      className={`icon-btn ${muted ? 'muted' : ''}`}
      onClick={handleClick}
      title={
        isForcedMuted
          ? 'Вы заглушены голосованием — можно будет включить микрофон позже'
          : muted
            ? 'Включить микрофон'
            : 'Выключить микрофон'
      }
    >
      {muted ? <MicOff size={17} /> : <Mic size={17} />}
    </button>
  )
}
