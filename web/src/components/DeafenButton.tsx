import { useVoice } from '../voice'
import { playToggleSound } from '../sounds'

/** Кнопка "не слушать остальных" (дефен) — работает только внутри VoiceProvider. */
export default function DeafenButton() {
  const { deafened, toggleDeafen } = useVoice()
  const handleClick = () => {
    playToggleSound(deafened) // deafened=true => сейчас возвращаем звук
    toggleDeafen()
  }
  return (
    <button
      className={`icon-btn ${deafened ? 'muted' : ''}`}
      onClick={handleClick}
      title={deafened ? 'Включить звук' : 'Отключить звук (не слышать участников)'}
    >
      {deafened ? '🔕' : '🎧'}
    </button>
  )
}
