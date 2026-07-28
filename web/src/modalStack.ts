import { useEffect } from 'react'

type CloseFn = () => void

/** Единственный источник правды "что сейчас открыто поверх всего". Каждый
 * модал/попап, пока он открыт, регистрирует здесь свой onClose — Escape
 * закрывает только самый верхний (последний зарегистрированный), следующий
 * Escape — тот, что под ним, и так далее.
 *
 * Раньше у каждого модала был свой независимый document-level keydown на
 * Escape (см. историю ServerSettingsModal/MiniProfilePopup) — если открыто
 * несколько разом (например, редактор сервера, а поверх него мини-профиль),
 * одно нажатие Escape срабатывало на ВСЕХ листенерах одновременно и гасило
 * всё разом, а не по одному сверху вниз. */
const stack: CloseFn[] = []

/** Подписать модал на Escape, пока он открыт. active=false — временно снять
 * с прослушивания, не размонтируя (например, модал сам сейчас поверх себя
 * показывает вложенный экран с собственным useEscToClose). */
export function useEscToClose(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    stack.push(onClose)
    return () => {
      const idx = stack.lastIndexOf(onClose)
      if (idx !== -1) stack.splice(idx, 1)
    }
  }, [active, onClose])
}

/** Единственный глобальный обработчик Escape — см. App.tsx. */
export function handleGlobalEscape() {
  const top = stack[stack.length - 1]
  if (top) top()
}
