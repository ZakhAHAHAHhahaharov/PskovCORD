import { useLayoutEffect, useRef } from 'react'
import {
  BellOff, BellRing, Check, ChevronRight, LogOut, Mail, Settings, ShieldCheck, Tag,
} from 'lucide-react'
import { NotificationLevel, Server } from '../api'
import { useHoverFlyout } from '../hooks/useHoverFlyout'

const MUTE_OPTIONS: { label: string; minutes: number }[] = [
  { label: '15 минут', minutes: 15 },
  { label: '30 минут', minutes: 30 },
  { label: '1 час', minutes: 60 },
  { label: '3 часа', minutes: 180 },
  { label: '8 часов', minutes: 480 },
  { label: '24 часа', minutes: 1440 },
]

const NOTIFICATION_LEVELS: { value: NotificationLevel; label: string }[] = [
  { value: 'all', label: 'Все сообщения' },
  { value: 'mentions', label: 'Только @упоминания' },
  { value: 'none', label: 'Ничего' },
]

/**
 * Правый клик по пилюле сервера в ServerRail — управление уведомлениями,
 * приглашение, доступ к настройкам/приватности, выход. Позиционирование и
 * закрытие по клику вне себя — тот же приём, что в ParticipantContextMenu;
 * подменю по наведению — тот же useHoverFlyout, что и в StatusMenu.
 */
export default function ServerContextMenu({
  server,
  x,
  y,
  canManageServer,
  canChangeNickname,
  isOwner,
  onClose,
  onMarkRead,
  onInvite,
  onMute,
  onUnmute,
  onNotificationLevel,
  onToggleIgnoreAtHere,
  onToggleSuppressRoleMentions,
  onOpenServerSettings,
  onOpenPrivacy,
  onChangeNickname,
  onLeave,
}: {
  server: Server
  x: number
  y: number
  /** Есть хоть одно из manage_server/manage_roles/manage_members — то же
   * условие, что открывает шестерёнку в ChannelSidebar. */
  canManageServer: boolean
  /** Право change_nickname — сменить СВОЙ никнейм на этом сервере. */
  canChangeNickname: boolean
  isOwner: boolean
  onClose: () => void
  onMarkRead: () => void
  onInvite: () => void
  onMute: (minutes: number | 'forever') => void
  onUnmute: () => void
  onNotificationLevel: (level: NotificationLevel) => void
  onToggleIgnoreAtHere: (value: boolean) => void
  onToggleSuppressRoleMentions: (value: boolean) => void
  onOpenServerSettings: () => void
  onOpenPrivacy: () => void
  onChangeNickname: () => void
  onLeave: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const muteFlyout = useHoverFlyout()
  const notifyFlyout = useHoverFlyout()
  const settings = server.my_settings

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

  return (
    <div
      ref={ref}
      className="profile-popup server-context-menu"
      style={{ left: x, top: y }}
    >
      <div className="profile-popup-menu">
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => {
            onMarkRead()
            onClose()
          }}
        >
          <Check size={15} /> Пометить как прочитанное
        </button>
      </div>

      <div className="profile-popup-divider" />

      <div className="profile-popup-menu">
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => {
            onInvite()
            onClose()
          }}
        >
          <Mail size={15} /> Пригласить на сервер
        </button>

        <div
          className="status-row-wrap"
          onMouseEnter={muteFlyout.onMouseEnter}
          onMouseLeave={muteFlyout.onMouseLeave}
        >
          <button type="button" className="profile-popup-item status-row">
            <BellOff size={15} />
            {settings.muted ? 'Сервер заглушён' : 'Заглушить сервер'}
            <ChevronRight size={15} className="status-row-chevron" />
          </button>

          {muteFlyout.open && (
            <div className="status-flyout server-menu-flyout">
              <div className="status-flyout-scroll">
                {settings.muted && (
                  <>
                    <button
                      type="button"
                      className="server-flyout-item"
                      onClick={() => {
                        onUnmute()
                        onClose()
                      }}
                    >
                      <BellRing size={14} /> Включить уведомления
                    </button>
                    <div className="profile-popup-divider" />
                  </>
                )}
                {MUTE_OPTIONS.map((o) => (
                  <button
                    key={o.minutes}
                    type="button"
                    className="server-flyout-item"
                    onClick={() => {
                      onMute(o.minutes)
                      onClose()
                    }}
                  >
                    {o.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`server-flyout-item ${settings.muted_forever ? 'active' : ''}`}
                  onClick={() => {
                    onMute('forever')
                    onClose()
                  }}
                >
                  До тех пор, пока не включу
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          className="status-row-wrap"
          onMouseEnter={notifyFlyout.onMouseEnter}
          onMouseLeave={notifyFlyout.onMouseLeave}
        >
          <button type="button" className="profile-popup-item status-row">
            <BellRing size={15} /> Параметры уведомлений
            <ChevronRight size={15} className="status-row-chevron" />
          </button>

          {notifyFlyout.open && (
            <div className="status-flyout server-menu-flyout">
              <div className="status-flyout-scroll">
                {NOTIFICATION_LEVELS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`server-flyout-item ${
                      settings.notification_level === o.value ? 'active' : ''
                    }`}
                    onClick={() => onNotificationLevel(o.value)}
                  >
                    {settings.notification_level === o.value && <Check size={13} />}
                    {o.label}
                  </button>
                ))}

                <div className="profile-popup-divider" />

                <label className="server-flyout-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.ignore_at_here}
                    onChange={(e) => onToggleIgnoreAtHere(e.target.checked)}
                  />
                  Игнорировать @all и @here
                </label>
                <label className="server-flyout-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.suppress_role_mentions}
                    onChange={(e) => onToggleSuppressRoleMentions(e.target.checked)}
                  />
                  Отключить все @упоминания ролей
                </label>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="profile-popup-divider" />
      <div className="profile-popup-menu">
        {canManageServer && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => {
              onOpenServerSettings()
              onClose()
            }}
          >
            <Settings size={15} /> Настройки сервера
          </button>
        )}
        {canChangeNickname && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => {
              onChangeNickname()
              onClose()
            }}
          >
            <Tag size={15} /> Изменить никнейм
          </button>
        )}
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => {
            onOpenPrivacy()
            onClose()
          }}
        >
          <ShieldCheck size={15} /> Настройки конфиденциальности
        </button>
      </div>

      <div className="profile-popup-divider" />
      <div className="profile-popup-menu">
        <button
          type="button"
          className="profile-popup-item message-action-danger"
          disabled={isOwner}
          title={isOwner ? 'Владелец не может покинуть свой сервер' : undefined}
          onClick={() => {
            if (isOwner) return
            onLeave()
            onClose()
          }}
        >
          <LogOut size={15} /> Покинуть сервер
        </button>
      </div>
    </div>
  )
}
