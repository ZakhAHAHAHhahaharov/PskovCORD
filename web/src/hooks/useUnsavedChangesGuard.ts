import { useCallback, useRef, useState } from 'react'

// Сколько повторных кликов подряд ещё считаются "одной попыткой" — за
// пределами этого окна счётчик амплитуды сбрасывается (пауза = человек
// смирился на секунду, следующий клик снова с базовой силой).
const RAPID_CLICK_WINDOW_MS = 1200
const BASE_AMPLITUDE_PX = 4
const AMPLITUDE_STEP_PX = 3
const MAX_AMPLITUDE_PX = 16

/**
 * Общий guard "не закрывать модал кликом мимо, если есть несохранённые
 * изменения" — вместо закрытия модал трясётся (сильнее при частых повторных
 * попытках) и показывает плашку "Изменения не сохранены" с Сброс/Сохранить
 * (см. UnsavedChangesNudge). Если isDirty=false, ведёт себя как обычно —
 * просто закрывает (терять нечего).
 *
 * Использование (см. StatusEditModal/BannerEditorModal/ServerSettingsModal/
 * DisplayNameStyleModal): modalRef — на .modal (там же тряска и восстановление
 * анимации), handleOverlayClick — на .modal-overlay ВМЕСТО обычного onClick={onClose}.
 * showNudge — рисовать ли плашку. Плашку и .modal нужно завернуть в общий
 * flex-column контейнер БЕЗ overflow (не внутрь самого .modal — у него
 * overflow:auto для скролла длинного контента, абсолютно спозиционированный
 * потомок с top:100% был бы им обрезан).
 *
 * isDirty — либо просто boolean (обычный случай, один компонент с локальным
 * черновиком), либо геттер () => boolean — нужен ServerSettingsModal, где сам
 * .modal-overlay живёт в родителе, а черновик — в компоненте активной
 * вкладки (см. TabHandle/activeTabRef там): геттер читает актуальное
 * значение прямо в момент клика, не требуя поднимать состояние вкладки
 * реактивно в родителя.
 */
export function useUnsavedChangesGuard(
  isDirty: boolean | (() => boolean),
  onClose: () => void,
) {
  const modalRef = useRef<HTMLDivElement>(null)
  const [showNudge, setShowNudge] = useState(false)
  const clickTimesRef = useRef<number[]>([])

  const handleOverlayClick = useCallback(() => {
    const dirty = typeof isDirty === 'function' ? isDirty() : isDirty
    if (!dirty) {
      onClose()
      return
    }
    const now = Date.now()
    clickTimesRef.current = [
      ...clickTimesRef.current.filter((t) => now - t < RAPID_CLICK_WINDOW_MS),
      now,
    ]
    setShowNudge(true)

    const el = modalRef.current
    if (el) {
      const amplitude = Math.min(
        MAX_AMPLITUDE_PX,
        BASE_AMPLITUDE_PX + (clickTimesRef.current.length - 1) * AMPLITUDE_STEP_PX,
      )
      el.style.setProperty('--shake-amplitude', `${amplitude}px`)
      // Браузер не перезапускает CSS-анимацию от повторного добавления ТОГО
      // ЖЕ класса — единственный надёжный способ прервать и переиграть её
      // заново: снять класс, форсировать reflow чтением offsetWidth (иначе
      // remove+add в одном тике браузер схлопнет и ничего не увидит), и
      // добавить обратно.
      el.classList.remove('modal-shake')
      void el.offsetWidth
      el.classList.add('modal-shake')
    }
  }, [isDirty, onClose])

  const dismissNudge = useCallback(() => setShowNudge(false), [])

  return { modalRef, showNudge, handleOverlayClick, dismissNudge }
}
