import { useVoice } from '../voice'

/** Кнопка «Демонстрация экрана» — работает только внутри VoiceProvider (в голосе). */
export default function ScreenShareButton() {
  const { isSharingScreen, toggleScreenShare } = useVoice()
  return (
    <button
      className={`icon-btn ${isSharingScreen ? 'sharing' : ''}`}
      onClick={toggleScreenShare}
      title={isSharingScreen ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}
    >
      🖥️
    </button>
  )
}
