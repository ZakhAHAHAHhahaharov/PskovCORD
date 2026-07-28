import { useRef, TouchEvent as ReactTouchEvent } from 'react'

const MOVE_CANCEL_PX = 10

/** Место, куда пришёлся долгий тап — этого достаточно везде, где сейчас
 * читают только .clientX/.clientY из MouseEvent правого клика (все
 * onContextMenu в проекте именно так и делают, см. например
 * AppShell.openParticipantContextMenu). */
export interface LongPressPoint {
  clientX: number
  clientY: number
}

/** Long-press — тач-аналог правого клика: палец держат `ms`, не уводя дальше
 * MOVE_CANCEL_PX — срабатывает onLongPress; сдвинули раньше (скролл/свайп)
 * или убрали палец — отмена. Возвращаемые пропсы навешиваются РЯДОМ с уже
 * существующим onContextMenu, не заменяя его — правый клик мышью остаётся
 * как есть. */
export function useLongPress(onLongPress: (point: LongPressPoint) => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  return {
    onTouchStart: (e: ReactTouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      start.current = { x: t.clientX, y: t.clientY }
      clear()
      timer.current = setTimeout(() => {
        onLongPress({ clientX: t.clientX, clientY: t.clientY })
      }, ms)
    },
    onTouchMove: (e: ReactTouchEvent) => {
      const t = e.touches[0]
      if (!t || !start.current) return
      const dx = t.clientX - start.current.x
      const dy = t.clientY - start.current.y
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clear()
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  }
}
