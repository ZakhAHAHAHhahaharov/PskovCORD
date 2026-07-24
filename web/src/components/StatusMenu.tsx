import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import { UserStatus } from '../api'
import Avatar from './Avatar'

const OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'online', label: 'В сети' },
  { value: 'dnd', label: 'Не беспокоить' },
  { value: 'invisible', label: 'Невидимка' },
]

export const STATUS_LABELS: Record<UserStatus, string> = {
  online: 'В сети',
  dnd: 'Не беспокоить',
  invisible: 'Невидимка',
}

/** Клик по своему аватару/имени в панели — открывает карточку профиля
 * с выбором действия (редактировать профиль / сменить статус). */
export default function StatusMenu({
  speaking = false,
  onOpenProfile,
}: {
  speaking?: boolean
  onOpenProfile: () => void
}) {
  const { user, updateLocalStatus } = useAuth()
  const gateway = useGateway()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!user) return null

  const choose = (status: UserStatus) => {
    gateway.setStatus(status)
    updateLocalStatus(status)
    setOpen(false)
  }

  return (
    <div className="status-menu" ref={ref}>
      <button
        type="button"
        className="user-panel-id status-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Изменить статус"
      >
        <Avatar
          name={user.username}
          color={user.avatar_color}
          image={user.avatar_image}
          size={32}
          status={user.status}
          showStatus
          speaking={speaking}
        />
        <div className="user-panel-names">
          <span className="user-panel-username">{user.username}</span>
          <span className="user-panel-status">{STATUS_LABELS[user.status]}</span>
        </div>
      </button>

      {open && (
        <div className="status-menu-popup profile-popup">
          <div className="profile-popup-banner">
            <Avatar
              name={user.username}
              color={user.avatar_color}
              image={user.avatar_image}
              size={56}
              status={user.status}
              showStatus
            />
            <span className="profile-popup-name">{user.username}</span>
          </div>

          <div className="profile-popup-menu">
            <button
              type="button"
              className="profile-popup-item"
              onClick={() => {
                setOpen(false)
                onOpenProfile()
              }}
            >
              Редактировать профиль
            </button>

            <div className="profile-popup-divider" />
            <div className="profile-popup-label">Статус</div>
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`status-menu-item ${user.status === o.value ? 'active' : ''}`}
                onClick={() => choose(o.value)}
              >
                <span className={`status-menu-dot ${o.value}`} />
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
