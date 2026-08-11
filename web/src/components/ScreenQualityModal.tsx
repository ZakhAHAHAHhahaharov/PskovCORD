import { useState } from 'react'
import { Monitor, MonitorPlay } from 'lucide-react'
import { ScreenFps, ScreenHeight, useSettings } from '../settings'
import { useEscToClose } from '../modalStack'

const HEIGHTS: { value: ScreenHeight; label: string; hint: string }[] = [
  { value: 720, label: '720p', hint: 'Экономно — хватает для текста и интерфейса' },
  { value: 1080, label: '1080p', hint: 'Обычный выбор' },
  { value: 1440, label: '1440p', hint: 'Чётче, заметно тяжелее для канала' },
  { value: 0, label: 'Как в источнике', hint: 'Без ограничения — сколько отдаст экран' },
]

const FPS_OPTIONS: { value: ScreenFps; label: string; hint: string }[] = [
  { value: 15, label: '15', hint: 'Документы и код' },
  { value: 30, label: '30', hint: 'Обычный выбор' },
  { value: 60, label: '60', hint: 'Игры и видео' },
]

/**
 * Выбор качества перед запуском демонстрации экрана.
 *
 * Спрашивается КАЖДЫЙ раз, а не прячется в общие настройки: показать
 * документ и показать игру — разные задачи с разной ценой для канала, и
 * выбранное в прошлый раз для одного почти наверняка не подходит другому.
 * Прошлый выбор при этом подставлен заранее — те, кому всё равно, просто
 * жмут «Начать».
 *
 * Разрешение и частота ограничивают КАРТИНКУ, но не поток: потолок битрейта
 * считается отдельно (screenMaxBitrate) и уезжает в mediasoup — без него
 * кодек раздувается на резком движении независимо от разрешения.
 */
export default function ScreenQualityModal({
  onStart,
  onClose,
}: {
  onStart: (height: ScreenHeight, fps: ScreenFps) => void
  onClose: () => void
}) {
  const { screenHeight, screenFps, setScreenQuality } = useSettings()
  const [height, setHeight] = useState<ScreenHeight>(screenHeight)
  const [fps, setFps] = useState<ScreenFps>(screenFps)

  useEscToClose(onClose)

  const start = () => {
    // Запоминаем выбор для следующего раза — подставится сюда же.
    setScreenQuality(height, fps)
    onStart(height, fps)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal screen-quality-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          <MonitorPlay size={18} /> Демонстрация экрана
        </h2>

        <div className="field-label">Разрешение</div>
        <div className="screen-quality-options">
          {HEIGHTS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`screen-quality-option ${height === option.value ? 'active' : ''}`}
              onClick={() => setHeight(option.value)}
            >
              <span className="screen-quality-option-label">{option.label}</span>
              <span className="screen-quality-option-hint">{option.hint}</span>
            </button>
          ))}
        </div>

        <div className="field-label">Частота кадров</div>
        <div className="screen-quality-fps">
          {FPS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`screen-quality-option ${fps === option.value ? 'active' : ''}`}
              onClick={() => setFps(option.value)}
            >
              <span className="screen-quality-option-label">{option.label} кадр/с</span>
              <span className="screen-quality-option-hint">{option.hint}</span>
            </button>
          ))}
        </div>

        <div className="settings-hint">
          <Monitor size={12} /> Что именно показывать — окно, вкладку или весь
          экран — спросит браузер следующим шагом.
        </div>

        <div className="create-channel-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn-primary" onClick={start}>
            Начать
          </button>
        </div>
      </div>
    </div>
  )
}
