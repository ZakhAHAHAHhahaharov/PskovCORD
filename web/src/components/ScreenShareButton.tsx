import { useState } from 'react'
import { Monitor } from 'lucide-react'
import { useVoice } from '../voice'
import ScreenQualityModal from './ScreenQualityModal'

/** Кнопка «Демонстрация экрана» — работает только внутри VoiceProvider (в голосе).
 *
 * Запуск идёт через попап выбора качества, остановка — сразу по клику:
 * спрашивать «в каком качестве прекратить показ» не о чем. */
export default function ScreenShareButton() {
  const { isSharingScreen, toggleScreenShare } = useVoice()
  // Точка клика — попап встаёт над ней (см. ScreenQualityModal). Координаты
  // берём у САМОЙ КНОПКИ, а не у курсора: по центру её верхнего края попап
  // висит одинаково и при клике мышью, и при нажатии с клавиатуры, где
  // координат курсора нет вовсе.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  return (
    <>
      <button
        className={`icon-btn ${isSharingScreen ? 'sharing' : ''}`}
        onClick={(e) => {
          if (isSharingScreen) {
            toggleScreenShare()
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left + rect.width / 2, y: rect.top })
        }}
        title={isSharingScreen ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}
      >
        <Monitor size={17} />
      </button>
      {anchor && (
        <ScreenQualityModal
          anchor={anchor}
          onStart={(height, fps) => toggleScreenShare({ height, fps })}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  )
}
