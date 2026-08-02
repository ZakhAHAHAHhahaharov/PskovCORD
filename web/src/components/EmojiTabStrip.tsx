import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Горизонтальная лента вкладок пикера, которая не влезает в свою ширину.
 *
 * Прокручивается двумя способами сразу, и оба обязательны: стрелками по краям
 * (появляются только когда есть куда листать) и перетаскиванием зажатой левой
 * кнопкой. Одного колеса мыши мало — горизонтальной прокрутки колесом нет на
 * большинстве мышей, а на тачпаде она есть, но неочевидна.
 *
 * Отдельный компонент, а не пара хуков внутри пикера: таких лент в пикере
 * ДВЕ — стандартные категории и наборы серверов, — и они устроены одинаково.
 */

/** Насколько «шевельнулась» мышь, чтобы это считалось перетаскиванием, а не
 * промахнувшимся кликом. Ноль не годится: палец на кнопке мыши всегда даёт
 * дрожание в пиксель-другой, и каждый клик по вкладке начинал бы «тащить». */
const DRAG_THRESHOLD_PX = 4

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

  // --- перетаскивание -------------------------------------------------------
  // Всё в ref'ах, а не в состоянии: перерисовывать ленту на каждый mousemove
  // не нужно (двигается только scrollLeft), а лишний рендер на кадр движения
  // мыши заметно её тормозит.
  const drag = useRef<{ startX: number; startScroll: number; moved: boolean } | null>(null)

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const el = ref.current
    if (!el) return
    drag.current = { startX: e.clientX, startScroll: el.scrollLeft, moved: false }
  }

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const state = drag.current
      const el = ref.current
      if (!state || !el) return
      const dx = e.clientX - state.startX
      if (!state.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
      state.moved = true
      el.scrollLeft = state.startScroll - dx
      measure()
    }
    const onMouseUp = () => {
      drag.current = null
    }
    // На document, а не на самой ленте: тащить продолжают и когда курсор ушёл
    // за её пределы, а отпускают кнопку вообще где угодно.
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [measure])

  // Клик после перетаскивания гасим на фазе перехвата: иначе «дотащили до
  // нужного набора и отпустили» открывало бы ту вкладку, на которой случайно
  // оказался курсор.
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current?.moved) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

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
