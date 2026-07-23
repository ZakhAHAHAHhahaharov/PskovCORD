import { useVoice } from '../voice'

/** Кнопка "не слушать остальных" (дефен) — работает только внутри VoiceProvider. */
export default function DeafenButton() {
  const { deafened, toggleDeafen } = useVoice()
  return (
    <button
      className={`icon-btn ${deafened ? 'muted' : ''}`}
      onClick={toggleDeafen}
      title={deafened ? 'Включить звук' : 'Отключить звук (не слышать участников)'}
    >
      {deafened ? '🔕' : '🎧'}
    </button>
  )
}
