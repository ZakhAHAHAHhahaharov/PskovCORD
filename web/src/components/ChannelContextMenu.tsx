import { FormEvent, useLayoutEffect, useRef, useState } from 'react'
import {
  Check, Eye, EyeOff, Link as LinkIcon, MessageSquare, Pin, Timer, UserPlus,
} from 'lucide-react'
import { useHiddenNames } from '../hiddenNames'

export interface ChannelContextMenuChannel {
  id: number
  name: string
  kind: 'text' | 'voice'
  status: string
  slowmode_seconds: number
}

/** Пресеты медленного режима — те же ступени, что и в Discord: между 5 с и
 * 6 ч свободный ввод секунд был бы точностью, которая никому не нужна. */
const SLOWMODE_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'Выкл.' },
  { value: 5, label: '5 с' },
  { value: 10, label: '10 с' },
  { value: 30, label: '30 с' },
  { value: 60, label: '1 мин' },
  { value: 300, label: '5 мин' },
  { value: 900, label: '15 мин' },
  { value: 3600, label: '1 ч' },
  { value: 21600, label: '6 ч' },
]

/**
 * Правый клик по каналу в ChannelSidebar. Позиционирование и закрытие по
 * клику вне себя/Escape — тот же приём, что в ServerContextMenu.
 *
 * Набор пунктов зависит от вида канала: приглашение/ссылка/статус/«скрыть
 * имена» — про голосовой, медленный режим — про текстовый (сообщений в
 * голосовом нет, ограничивать нечего, см. backend ChannelDetail.patch).
 * Всё, что меняет САМ канал, показывается только при manage_channels;
 * закрепление и «скрыть имена» — личная раскладка, доступна любому, кто
 * видит канал.
 *
 * useHiddenNames() читается прямо здесь (не пропсом) — это контекст из
 * VoiceProvider, а рендерится это меню внутри него же (см. AppShell), но САМ
 * AppShell — предок VoiceProvider, а не потомок, и не смог бы прочитать этот
 * контекст у себя в теле функции.
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
  onSetSlowmode,
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
  onSetSlowmode: (seconds: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [statusDraft, setStatusDraft] = useState(channel.status)
  const { isHidden, setHidden } = useHiddenNames()
  const hideNames = isHidden(channel.id)
  const isVoice = channel.kind === 'voice'

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
        {isVoice && (
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
        )}
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
        {isVoice && (
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
        )}
      </div>

      {isVoice && canManageChannels && (
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

      {!isVoice && canManageChannels && (
        <>
          <div className="profile-popup-divider" />
          <div className="settings-field channel-menu-status">
            <div className="settings-field-header">
              <span className="settings-field-label">
                <Timer size={14} /> Медленный режим
              </span>
            </div>
            <div className="channel-menu-slowmode">
              {SLOWMODE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`btn-small channel-menu-slowmode-item ${
                    channel.slowmode_seconds === preset.value ? 'active' : ''
                  }`}
                  onClick={() => {
                    onSetSlowmode(preset.value)
                    onClose()
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {isVoice && (
        <>
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
        </>
      )}
    </div>
  )
}
