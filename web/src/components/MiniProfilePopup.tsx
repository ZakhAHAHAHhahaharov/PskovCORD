import { useLayoutEffect, useRef } from 'react'
import { UserPlus, MessageSquare } from 'lucide-react'
import Avatar from './Avatar'

export interface ProfilePopupUser {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  banner_gradient?: string
  banner_image?: string
  status?: 'online' | 'dnd' | 'offline' | 'invisible'
}

export interface ProfilePopupTarget {
  user: ProfilePopupUser
  /** Координаты клика (clientX/clientY) — попап всплывает рядом с ним. */
  x: number
  y: number
}

/**
 * Мини-профиль — всплывает рядом с кликом по аватарке/нику где угодно (чат,
 * список участников, войс-канал). Переиспользует .profile-popup из
 * StatusMenu (тот же вид карточки), но позиционируется у курсора, а не под
 * триггером, и живёт на уровне AppShell, а не внутри конкретного списка.
 */
export default function MiniProfilePopup({
  target,
  currentUserId,
  onClose,
}: {
  target: ProfilePopupTarget
  currentUserId: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { user } = target
  const isSelf = user.id === currentUserId

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let left = target.x
    let top = target.y
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height
    }
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [target.x, target.y])

  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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

  const notImplemented = () => alert('not implemented yet')

  return (
    <div
      ref={ref}
      className="profile-popup mini-profile-popup"
      style={{ left: target.x, top: target.y }}
    >
      <div
        className="profile-popup-banner"
        style={{
          background: user.banner_image ? undefined : user.banner_gradient || undefined,
          backgroundImage: user.banner_image ? `url(${user.banner_image})` : undefined,
        }}
      >
        <Avatar
          name={user.username}
          color={user.avatar_color}
          image={user.avatar_image}
          size={86}
          status={user.status}
          showStatus={!!user.status}
        />
        <span className="profile-popup-name">{user.username}</span>
      </div>

      {!isSelf && (
        <div className="profile-popup-menu">
          <button type="button" className="profile-popup-item" onClick={notImplemented}>
            <UserPlus size={15} /> Добавить в друзья
          </button>
          <button type="button" className="profile-popup-item" onClick={notImplemented}>
            <MessageSquare size={15} /> Написать сообщение
          </button>
        </div>
      )}
    </div>
  )
}
