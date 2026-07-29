import { FormEvent, useLayoutEffect, useRef, useState } from 'react'
import { Check, Eye, EyeOff, Link as LinkIcon, MessageSquare, Pin, UserPlus } from 'lucide-react'
import { useHiddenNames } from '../hiddenNames'

export interface ChannelContextMenuChannel {
  id: number
  name: string
  status: string
}

/**
 * Правый клик по голосовому каналу в ChannelSidebar. Позиционирование и
 * закрытие по клику вне себя/Escape — тот же приём, что в ServerContextMenu.
 * «Установить статус канала» показывается только тем, у кого есть
 * manage_channels (см. backend ChannelDetail.patch) — остальные три пункта и
 * чекбокс личные, доступны любому, кто видит канал. useHiddenNames() читается
 * прямо здесь (не пропсом) — это контекст из VoiceProvider, а рендерится это
 * меню внутри него же (см. AppShell), но САМ AppShell — предок VoiceProvider,
 * а не потомок, и не смог бы прочитать этот контекст у себя в теле функции.
 */
export default function ChannelContextMenu({
  channel,
  x,
  y,
  canManageChannels,
  isPinned,
  onClose,
  onInvite,
  onTogglePin,
  onCopyLink,
  onSetStatus,
}: {
  channel: ChannelContextMenuChannel
  x: number
  y: number
  canManageChannels: boolean
  isPinned: boolean
  onClose: () => void
  onInvite: () => void
  onTogglePin: () => void
  onCopyLink: () => void
  onSetStatus: (status: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [statusDraft, setStatusDraft] = useState(channel.status)
  const { isHidden, setHidden } = useHiddenNames()
  const hideNames = isHidden(channel.id)

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
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
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

  const submitStatus = (e: FormEvent) => {
    e.preventDefault()
    onSetStatus(statusDraft.trim())
    onClose()
  }

  return (
    <div ref={ref} className="profile-popup channel-context-menu" style={{ left: x, top: y }}>
      <div className="profile-popup-label">{channel.name}</div>

      <div className="profile-popup-menu">
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => {
            onInvite()
            onClose()
          }}
        >
          <UserPlus size={15} /> Пригласить в голосовой чат
        </button>
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => {
            onTogglePin()
            onClose()
          }}
        >
          <Pin size={15} /> {isPinned ? 'Открепить канал' : 'Закрепить канал вверху'}
        </button>
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => {
            onCopyLink()
            onClose()
          }}
        >
          <LinkIcon size={15} /> Копировать ссылку
        </button>
      </div>

      {canManageChannels && (
        <>
          <div className="profile-popup-divider" />
          <div className="settings-field channel-menu-status">
            <div className="settings-field-header">
              <span className="settings-field-label">
                <MessageSquare size={14} /> Статус канала
              </span>
            </div>
            <form className="invite-link-row" onSubmit={submitStatus}>
              <input
                className="field-input"
                value={statusDraft}
                onChange={(e) => setStatusDraft(e.target.value)}
                placeholder="Например, играем в CS"
                maxLength={120}
              />
              <button type="submit" className="btn-small" title="Сохранить статус">
                <Check size={14} />
              </button>
            </form>
          </div>
        </>
      )}

      <div className="profile-popup-divider" />
      <div className="profile-popup-menu">
        <label className="server-flyout-checkbox">
          <input
            type="checkbox"
            checked={hideNames}
            onChange={(e) => setHidden(channel.id, e.target.checked)}
          />
          {hideNames ? <EyeOff size={15} /> : <Eye size={15} />} Скрыть имена
        </label>
      </div>
    </div>
  )
}
