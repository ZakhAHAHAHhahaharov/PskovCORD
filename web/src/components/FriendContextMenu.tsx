import { useLayoutEffect, useRef } from 'react'
import { MessageSquare, Phone, Tag, User as UserIcon } from 'lucide-react'
import { User } from '../api'
import { useNickname } from '../nicknames'

/**
 * Правый клик по строке друга в списке «Друзья» (см. HomeSidebar).
 *
 * Позиционирование и закрытие по клику вне себя/Escape — тот же приём, что в
 * ConversationContextMenu/ChannelContextMenu. Пунктов намеренно четыре: это
 * меню про КОНКРЕТНОГО человека из списка друзей, а не про беседу с ним, —
 * всё, что относится к беседе (закрепить, пометить прочитанным, закрыть ЛС),
 * живёт в меню диалога и здесь было бы не к месту.
 */
export default function FriendContextMenu({
  friend,
  x,
  y,
  onClose,
  onOpenProfile,
  onSendMessage,
  onStartCall,
  onSetNickname,
}: {
  friend: User
  x: number
  y: number
  onClose: () => void
  onOpenProfile: () => void
  onSendMessage: () => void
  onStartCall: () => void
  onSetNickname: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const nickname = useNickname(friend.id)

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

  const item = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      type="button"
      className="profile-popup-item"
      onClick={() => {
        onClick()
        onClose()
      }}
    >
      {icon} {label}
    </button>
  )

  return (
    <div ref={ref} className="profile-popup channel-context-menu" style={{ left: x, top: y }}>
      <div className="profile-popup-menu">
        {item(<UserIcon size={15} />, 'Профиль', onOpenProfile)}
        {item(<MessageSquare size={15} />, 'Написать сообщение', onSendMessage)}
        {item(<Phone size={15} />, 'Начать звонок', onStartCall)}
        {item(
          <Tag size={15} />,
          nickname ? 'Изменить никнейм друга' : 'Добавить никнейм друга',
          onSetNickname,
        )}
      </div>
    </div>
  )
}
