import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MonitorPlay } from 'lucide-react'
import { ScreenFps, ScreenHeight, useSettings } from '../settings'
import { useEscToClose } from '../modalStack'

const HEIGHTS: { value: ScreenHeight; label: string; hint: string }[] = [
  { value: 720, label: '720p', hint: 'Экономно' },
  { value: 1080, label: '1080p', hint: 'Обычный выбор' },
  { value: 1440, label: '1440p', hint: 'Чётче, тяжелее' },
  { value: 0, label: 'Как в источнике', hint: 'Без ограничения' },
]

const FPS_OPTIONS: { value: ScreenFps; label: string; hint: string }[] = [
  { value: 15, label: '15', hint: 'Документы' },
  { value: 30, label: '30', hint: 'Обычный выбор' },
  { value: 60, label: '60', hint: 'Игры и видео' },
]

/** На сколько поднять попап над точкой клика. */
const GAP_ABOVE_CLICK = 10

/** Отступ от краёв экрана, за который попап не заезжает. */
const VIEWPORT_MARGIN = 8

/**
 * Выбор качества перед запуском демонстрации экрана.
 *
 * Попап у кнопки, а не центрированная модалка: кнопка живёт в панели
 * управления звонком внизу экрана, и перебрасывать взгляд в центр ради
 * двух переключателей незачем. Раскладка горизонтальная — в узкой колонке
 * варианты выстраивались лесенкой и занимали пол-экрана по высоте.
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
  anchor,
  onStart,
  onClose,
}: {
  /** Точка клика по кнопке демонстрации — попап встаёт над ней. */
  anchor: { x: number; y: number }
  onStart: (height: ScreenHeight, fps: ScreenFps) => void
  onClose: () => void
}) {
  const { screenHeight, screenFps, setScreenQuality } = useSettings()
  const [height, setHeight] = useState<ScreenHeight>(screenHeight)
  const [fps, setFps] = useState<ScreenFps>(screenFps)
  const ref = useRef<HTMLDivElement>(null)

  useEscToClose(onClose)

  // Позиционирование — после отрисовки: до неё размеры попапа неизвестны, а
  // они нужны, чтобы поднять его НАД точкой клика и прижать к краям экрана.
  // Тот же приём, что и у контекстных меню (см. ThreadContextMenu).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // По горизонтали — по центру кнопки, по вертикали — низом на GAP выше
    // точки клика.
    let left = anchor.x - rect.width / 2
    let top = anchor.y - GAP_ABOVE_CLICK - rect.height
    left = Math.min(left, window.innerWidth - VIEWPORT_MARGIN - rect.width)
    left = Math.max(VIEWPORT_MARGIN, left)
    // Не поместился сверху (окно низкое) — показываем под точкой клика:
    // обрезанный сверху попап хуже, чем открывшийся с другой стороны.
    if (top < VIEWPORT_MARGIN) top = anchor.y + GAP_ABOVE_CLICK
    top = Math.min(top, window.innerHeight - VIEWPORT_MARGIN - rect.height)
    el.style.left = `${left}px`
    el.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`
  }, [anchor.x, anchor.y])

  // Клик мимо закрывает. mousedown, а не click: до появления попапа под ним
  // могла остаться нажатой другая кнопка, и click по ней всплыл бы уже
  // после закрытия.
  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  const start = () => {
    // Запоминаем выбор для следующего раза — подставится сюда же.
    setScreenQuality(height, fps)
    onStart(height, fps)
    onClose()
  }

  // Портал в body — а не просто ребёнок ScreenShareButton (тот сидит внутри
  // .voice-controls-bar). У панели opacity:0/pointer-events:none, пока
  // курсор неподвижен (см. VoiceStage.CONTROLS_HIDE_DELAY_MS) — не выйди
  // попап порталом, он утащил бы это состояние тоже: opacity родителя
  // применяется ко всему поддереву рендера, ДАЖЕ к position:fixed
  // потомкам, значение самого попапа тут ничего не решает. Раньше
  // (центрированная модалка, см. ebddcd0) это было незаметно — путь курсора
  // к центру экрана сам сбрасывал таймер скрытия панели, а у попапа рядом с
  // кнопкой сбрасывать нечем: пауза на 2.5с при выборе качества гасила его
  // подряд с панелью, и по нему переставали попадать клики.
  return createPortal(
    <div className="screen-quality-popover" ref={ref}>
      <div className="screen-quality-head">
        <MonitorPlay size={15} /> Демонстрация экрана
      </div>

      <div className="screen-quality-row">
        <span className="screen-quality-row-label">Разрешение</span>
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
      </div>

      <div className="screen-quality-row">
        <span className="screen-quality-row-label">Кадров в секунду</span>
        <div className="screen-quality-options">
          {FPS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`screen-quality-option ${fps === option.value ? 'active' : ''}`}
              onClick={() => setFps(option.value)}
            >
              <span className="screen-quality-option-label">{option.label}</span>
              <span className="screen-quality-option-hint">{option.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="screen-quality-actions">
        <span className="screen-quality-note">
          Что показывать — окно, вкладку или весь экран — спросит браузер
        </span>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn-primary" onClick={start}>
          Начать
        </button>
      </div>
    </div>,
    document.body,
  )
}
