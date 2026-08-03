import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useDragScroll } from '../dragScroll'

/**
 * Горизонтальная лента вкладок пикера, которая не влезает в свою ширину.
 *
 * Прокручивается двумя способами сразу, и оба обязательны: стрелками по краям
 * (появляются только когда есть куда листать) и перетаскиванием зажатой левой
 * кнопкой (см. dragScroll.ts — тот же приём работает и в сетке пикера).
 * Одного колеса мыши мало — горизонтальной прокрутки колесом нет на
 * большинстве мышей, а на тачпаде она есть, но неочевидна.
 *
 * Отдельный компонент, а не пара хуков внутри пикера: таких лент в пикере
 * ДВЕ — стандартные категории и наборы серверов, — и они устроены одинаково.
 */

export default function EmojiTabStrip({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setCanLeft(el.scrollLeft > 1)
    // -1: браузер даёт дробные значения, и точное равенство здесь никогда не
    // выполняется — правая стрелка оставалась бы активной в самом конце.
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])

  // useLayoutEffect: стрелки должны быть в правильном состоянии в первом же
  // кадре, иначе они мигают при открытии панели.
  useLayoutEffect(measure, [measure, children])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // Ширина ленты меняется не только при ресайзе окна: набор эмодзи может
    // доехать по WebSocket уже при открытом пикере.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  const scrollBy = (direction: 1 | -1) => {
    const el = ref.current
    if (!el) return
    // На «страницу» минус вкладка — так на виду остаётся край предыдущего
    // экрана и не теряется ощущение, где ты в ленте.
    el.scrollBy({ left: direction * Math.max(60, el.clientWidth - 34), behavior: 'smooth' })
  }

  // Перетаскивание — общий хук (им же прокручивается сетка пикера). Лента
  // ездит только по горизонтали: вертикали у неё нет, а «оба направления»
  // означало бы, что случайный вертикальный рывок считается перетаскиванием и
  // съедает клик по вкладке.
  const { onMouseDown, onClickCapture } = useDragScroll(ref, {
    axis: 'x',
    onMove: measure,
  })

  return (
    <div className={`emoji-strip ${className}`}>
      {canLeft && (
        <button
          type="button"
          className="emoji-strip-arrow left"
          title="Влево"
          onClick={() => scrollBy(-1)}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div
        ref={ref}
        className="emoji-strip-track"
        onScroll={measure}
        onMouseDown={onMouseDown}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
      {canRight && (
        <button
          type="button"
          className="emoji-strip-arrow right"
          title="Вправо"
          onClick={() => scrollBy(1)}
        >
          <ChevronRight size={14} />
        </button>
      )}
    </div>
  )
}
