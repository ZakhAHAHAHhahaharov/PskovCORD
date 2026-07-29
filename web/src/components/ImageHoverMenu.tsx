import { ReactNode, useEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'

/**
 * Оборачивает превью картинки (аватар/баннер) — клик открывает компактный
 * поповер [Изменить]/[Удалить] вместо всегда видимой отдельной кнопки
 * удаления, как было раньше. Тот же визуальный язык, что у
 * .status-flyout/.account-flyout (StatusMenu.tsx) и то же закрытие по
 * клику вне себя, что у MiniProfilePopup/StatusMenu.
 */
export default function ImageHoverMenu({
  onEdit,
  onRemove,
  removeConfirm,
  canRemove,
  children,
  className,
}: {
  /** "Изменить" — открывает file picker (аватар) или отдельную модалку
   * (баннер, см. BannerEditorModal). */
  onEdit: () => void
  onRemove: () => void
  /** Текст window.confirm перед удалением. */
  removeConfirm: string
  /** Нечего удалять (картинка уже не задана) — пункт "Удалить" не рисуем. */
  canRemove: boolean
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  return (
    <div className={`image-hover-menu ${className ?? ''}`} ref={ref}>
      <button
        type="button"
        className="image-hover-menu-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <div className="image-hover-menu-popup">
          <button
            type="button"
            className="image-hover-menu-item"
            onClick={() => {
              setOpen(false)
              onEdit()
            }}
          >
            <Pencil size={14} /> Изменить
          </button>
          {canRemove && (
            <button
              type="button"
              className="image-hover-menu-item image-hover-menu-item-danger"
              onClick={() => {
                setOpen(false)
                if (window.confirm(removeConfirm)) onRemove()
              }}
            >
              <Trash2 size={14} /> Удалить
            </button>
          )}
        </div>
      )}
    </div>
  )
}
