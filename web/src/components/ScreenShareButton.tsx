import { useState } from 'react'
import { Monitor } from 'lucide-react'
import { useVoice } from '../voice'
import ScreenQualityModal from './ScreenQualityModal'

/** Кнопка «Демонстрация экрана» — работает только внутри VoiceProvider (в голосе).
 *
 * Запуск идёт через модалку выбора качества, остановка — сразу по клику:
 * спрашивать «в каком качестве прекратить показ» не о чем. */
export default function ScreenShareButton() {
  const { isSharingScreen, toggleScreenShare } = useVoice()
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <>
      <button
        className={`icon-btn ${isSharingScreen ? 'sharing' : ''}`}
        onClick={() => (isSharingScreen ? toggleScreenShare() : setPickerOpen(true))}
        title={isSharingScreen ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}
      >
        <Monitor size={17} />
      </button>
      {pickerOpen && (
        <ScreenQualityModal
          onStart={(height, fps) => toggleScreenShare({ height, fps })}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
}
