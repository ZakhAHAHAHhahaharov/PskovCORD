import { useLayoutEffect, useRef } from 'react'
import { FolderPlus, Pencil, Trash2 } from 'lucide-react'

/**
 * Правый клик по названию раздела в сайдбаре.
 *
 * Позиционирование и закрытие — как у ThreadContextMenu/ChannelContextMenu:
 * прижимаемся к краю экрана, закрываемся по клику мимо и по Esc. Флайаутов
 * нет — пунктов всего три, и вложенная панель была бы тяжелее самого меню.
 *
 * Показывается только тем, кто распоряжается каналами: остальным здесь нет
 * ни одного доступного действия (см. ChannelSidebar, onCategoryContextMenu
 * не передаётся вовсе).
 */
export default function CategoryContextMenu({
  x,
  y,
  name,
  onClose,
  onRename,
  onDelete,
  onCreateCategory,
}: {
  x: number
  y: number
  name: string
  onClose: () => void
  onRename: () => void
  onDelete: () => void
  onCreateCategory: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height
    }
    el.style.left = `${Math.max(margin, left)}px`
    el.style.top = `${Math.max(margin, top)}px`
  }, [x, y])

  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  /** Каждый пункт сам закрывает меню — это однократный выбор действия. */
  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div className="profile-popup channel-context-menu" ref={ref}>
      <div className="profile-popup-menu">
        <div className="profile-popup-label">{name}</div>
        <button className="profile-popup-item" onClick={act(onRename)}>
          <Pencil size={14} /> Переименовать раздел
        </button>
        <button className="profile-popup-item" onClick={act(onCreateCategory)}>
          <FolderPlus size={14} /> Создать раздел
        </button>
        <div className="profile-popup-divider" />
        {/* Удаление раздела НЕ удаляет каналы — они становятся «вне разделов»
            (см. backend, SET_NULL). Говорим об этом прямо в подписи: иначе
            удалять «папку» с каналами внутри страшно, и человек не станет. */}
        <button
          className="profile-popup-item profile-popup-item-danger"
          onClick={act(onDelete)}
        >
          <Trash2 size={14} /> Удалить раздел
        </button>
        <div className="profile-popup-label">Каналы внутри останутся</div>
      </div>
    </div>
  )
}
