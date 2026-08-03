/**
 * Прокрутка содержимого перетаскиванием зажатой левой кнопкой — «схватил и
 * потянул», как карту.
 *
 * Зачем: колесо мыши закрывает только вертикаль, и только если колесо вообще
 * есть. Горизонтальной прокрутки колесом нет почти нигде (ленты вкладок в
 * пикере), а на мыши без колеса — например, на многих беспроводных «плоских»
 * мышах и на трекболах — недоступна и вертикальная. Перетаскивание работает
 * везде и одинаково.
 *
 * Общий хук, а не пара обработчиков на месте: одинаковое поведение нужно и
 * лентам вкладок (EmojiTabStrip, горизонталь), и сетке пикера (вертикаль), и
 * порознь эти копии разъезжались бы — начиная с порога срабатывания.
 */
import { RefObject, useCallback, useEffect, useRef } from 'react'

/** Насколько «шевельнулась» мышь, чтобы это считалось перетаскиванием, а не
 * промахнувшимся кликом. Ноль не годится: палец на кнопке мыши всегда даёт
 * дрожание в пиксель-другой, и каждый клик по эмодзи начинал бы «тащить». */
const DRAG_THRESHOLD_PX = 4

interface DragState {
  startX: number
  startY: number
  startLeft: number
  startTop: number
  /** Мышь уехала дальше порога — значит это перетаскивание, а не клик.
   * Переживает mouseup: click приходит уже после него, и решение «гасить или
   * пропустить» принимается по этому флагу. */
  moved: boolean
  /** Кнопка ещё зажата. */
  active: boolean
}

export interface DragScrollHandlers {
  onMouseDown: (e: React.MouseEvent) => void
  /** Гасит клик, случившийся сразу после перетаскивания, — вешать на тот же
   * элемент, что и onMouseDown. */
  onClickCapture: (e: React.MouseEvent) => void
}

export function useDragScroll(
  ref: RefObject<HTMLElement | null>,
  {
    axis = 'both',
    onMove,
  }: {
    /** Какие оси двигать. Лишняя ось безвредна (scrollLeft у неподвижного по
     * горизонтали элемента просто ноль), но с ней вертикальный рывок в ленте
     * вкладок ощущался бы как «залипание». */
    axis?: 'x' | 'y' | 'both'
    /** Позвать после каждого сдвига — например, пересчитать стрелки ленты. */
    onMove?: () => void
  } = {},
): DragScrollHandlers {
  // Всё в ref'ах, а не в состоянии: перерисовывать содержимое на каждый
  // mousemove не нужно (двигается только scrollTop/scrollLeft), а лишний
  // рендер на кадр движения мыши заметно его тормозит.
  const drag = useRef<DragState | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Сбрасываем в любом случае, даже если тащить не начнём: незакрытое
      // состояние от прошлого перетаскивания (его отпустили за пределами
      // элемента, и click до onClickCapture так и не дошёл) погасило бы
      // следующий честный клик.
      drag.current = null
      if (e.button !== 0) return
      const el = ref.current
      if (!el) return
      // Внутри полей ввода перетаскивание — это выделение текста, и отбирать
      // его нельзя: поиск в пикере лежит в той же панели.
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        startLeft: el.scrollLeft,
        startTop: el.scrollTop,
        moved: false,
        active: true,
      }
    },
    [ref],
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const state = drag.current
      const el = ref.current
      if (!state || !state.active || !el) return
      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      if (
        !state.moved &&
        Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD_PX
      ) {
        return
      }
      state.moved = true
      if (axis !== 'y') el.scrollLeft = state.startLeft - dx
      if (axis !== 'x') el.scrollTop = state.startTop - dy
      onMove?.()
    }
    const onMouseUp = () => {
      const state = drag.current
      if (!state) return
      state.active = false
      // Ничего не тащили — состояние больше не нужно; onClickCapture пусть
      // видит пустоту и пропускает клик как обычный.
      if (!state.moved) drag.current = null
    }
    // На document, а не на самом элементе: тащить продолжают и когда курсор
    // ушёл за его пределы, а отпускают кнопку вообще где угодно.
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [ref, axis, onMove])

  // Клик после перетаскивания гасим на фазе перехвата: иначе «дотащили до
  // нужного набора и отпустили» вставляло бы эмодзи, на котором случайно
  // оказался курсор.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const moved = drag.current?.moved
    drag.current = null
    if (moved) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, [])

  return { onMouseDown, onClickCapture }
}
