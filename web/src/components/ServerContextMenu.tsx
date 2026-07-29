import { useLayoutEffect, useRef } from 'react'
import {
  BellOff, BellRing, Check, ChevronRight, LogOut, Mail, Settings, ShieldCheck,
} from 'lucide-react'
import { Server } from '../api'

/**
 * Правый клик по пилюле сервера в ServerRail — управление уведомлениями,
 * приглашение, доступ к настройкам/приватности, выход. Позиционирование и
 * закрытие по клику вне себя — тот же приём, что в ParticipantContextMenu.
 *
 * Заглушение и параметры уведомлений открывают отдельные модальные окна
 * (ServerMuteModal/ServerNotificationsModal), а не подменю-флауты: их списки
 * не помещались в попап, и он обзаводился полосами прокрутки.
 */
export default function ServerContextMenu({
  server,
  x,
  y,
  canManageServer,
  isOwner,
  onClose,
  onMarkRead,
  onInvite,
  onOpenMute,
  onOpenNotifications,
  onOpenServerSettings,
  onOpenPrivacy,
  onLeave,
}: {
  server: Server
  x: number
  y: number
  /** Есть хоть одно из manage_server/manage_roles/manage_members — то же
   * условие, что открывает шестерёнку в ChannelSidebar. */
  canManageServer: boolean
  isOwner: boolean
  onClose: () => void
  onMarkRead: () => void
  onInvite: () => void
  onOpenMute: () => void
  onOpenNotifications: () => void
  onOpenServerSettings: () => void
  onOpenPrivacy: () => void
  onLeave: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
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
      <div className="profile-popup-label">{server.name}</div>
      <div className="profile-popup-divider" />

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

        <button
          type="button"
          className="profile-popup-item status-row"
          onClick={() => {
            onOpenMute()
            onClose()
          }}
        >
          <BellOff size={15} />
          <span className="server-context-menu-text">
            {settings.muted ? 'Сервер заглушён' : 'Заглушить сервер'}
          </span>
          <ChevronRight size={15} className="status-row-chevron" />
        </button>

        <button
          type="button"
          className="profile-popup-item status-row"
          onClick={() => {
            onOpenNotifications()
            onClose()
          }}
        >
          <BellRing size={15} />
          <span className="server-context-menu-text">Параметры уведомлений</span>
          <ChevronRight size={15} className="status-row-chevron" />
        </button>
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
