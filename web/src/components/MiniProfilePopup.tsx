import { useLayoutEffect, useRef, useState, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { UserPlus, MessageSquare, Smile } from 'lucide-react'
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
  isFriend,
  onClose,
  onAddFriend,
  onSendMessage,
}: {
  target: ProfilePopupTarget
  currentUserId: number
  /** Уже друзья — вместо «Добавить в друзья» показываем пометку (попап
   * теперь открывается и прямо из списка друзей, см. HomeSidebar). */
  isFriend: boolean
  onClose: () => void
  onAddFriend: (userId: number) => void
  onSendMessage: (userId: number, content: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')
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

  const handleComposeKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const content = message.trim()
      if (!content) return
      onSendMessage(user.id, content)
    }
  }

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
          {isFriend ? (
            <div className="profile-popup-item mini-profile-note">
              <UserPlus size={15} /> Уже в друзьях
            </div>
          ) : (
            <button
              type="button"
              className="profile-popup-item mini-profile-action"
              onClick={() => onAddFriend(user.id)}
            >
              <UserPlus size={15} /> Добавить в друзья
            </button>
          )}
          {composing ? (
            <div className="mini-profile-compose">
              <input
                className="mini-profile-compose-input"
                placeholder={`Сообщение для ${user.username}`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleComposeKeyDown}
                autoFocus
              />
              <button
                type="button"
                className="mini-profile-compose-emoji"
                title="Эмодзи (пока не реализовано)"
                disabled
              >
                <Smile size={16} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="profile-popup-item mini-profile-action"
              onClick={() => setComposing(true)}
            >
              <MessageSquare size={15} /> Написать сообщение
            </button>
          )}
        </div>
      )}
    </div>
  )
}
