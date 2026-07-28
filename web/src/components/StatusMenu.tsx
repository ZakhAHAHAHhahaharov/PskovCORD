import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, Check, Plus, Loader2, Users } from 'lucide-react'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import { UserStatus } from '../api'
import { MAX_ACCOUNTS } from '../accounts'
import Avatar from './Avatar'
import CallTopic from './CallTopic'
import AddAccountModal from './AddAccountModal'
import { VoiceState } from './AppShell'
import { VoiceRosterMember } from './VoiceStage'

const OPTIONS: { value: UserStatus; label: string; caption: string }[] = [
  {
    value: 'online',
    label: 'В сети',
    caption: 'Другие видят, что вы активны и на связи.',
  },
  {
    value: 'dnd',
    label: 'Не беспокоить',
    caption: 'Другие видят, что сейчас лучше вас не отвлекать.',
  },
  {
    value: 'invisible',
    label: 'Невидимка',
    caption: 'Вы выглядите офлайн для всех, оставаясь на связи сами.',
  },
]

export const STATUS_LABELS: Record<UserStatus, string> = {
  online: 'В сети',
  dnd: 'Не беспокоить',
  invisible: 'Невидимка',
}

const ROSTER_PREVIEW_LIMIT = 5

// Открытие/закрытие синхронно по mouseenter/mouseleave, без задержки: зазор
// между строкой-триггером и флаутом (см. .status-flyout — left: calc(100% +
// 8px)) перекрыт псевдоэлементом ::before самого флаута (.status-flyout::before
// в index.css) — курсор в зазоре физически лежит над флаутом (его потомком в
// DOM), поэтому mouseleave обёртки там не срабатывает и без искусственной
// задержки. Раньше зазор был "мёртвой зоной" ничьей — курсор успевал выйти и
// из триггера, и из флаута.
//
// Экспортирован — переиспользуется и в ServerContextMenu.tsx (заглушение/
// параметры уведомлений открываются тем же наведением).
export function useHoverFlyout() {
  const [open, setOpen] = useState(false)
  return {
    open,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    close: () => setOpen(false),
  }
}

/** Клик по своему аватару/имени в панели — открывает карточку профиля из 4
 * блоков: мини-профиль, (опционально) текущий голосовой звонок, редактирование
 * профиля/статуса, переключение аккаунтов. */
export default function StatusMenu({
  speaking = false,
  onOpenProfile,
  voice,
  voiceRoster,
  voiceTopic,
}: {
  speaking?: boolean
  onOpenProfile: () => void
  voice: VoiceState | null
  voiceRoster: VoiceRosterMember[]
  voiceTopic: string | null
}) {
  const { user, updateLocalStatus, knownAccounts, switchAccount } = useAuth()
  const gateway = useGateway()
  const [open, setOpen] = useState(false)
  const statusFlyout = useHoverFlyout()
  const accountFlyout = useHoverFlyout()
  const [showAddAccount, setShowAddAccount] = useState(false)
  const [switchingId, setSwitchingId] = useState<number | null>(null)
  const [switchError, setSwitchError] = useState('')
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        statusFlyout.close()
        accountFlyout.close()
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
    // statusFlyout/accountFlyout — новый объект на каждый рендер, но их
    // .close() всегда дёргает один и тот же стабильный setState конкретного
    // useHoverFlyout(), так что включать их в deps незачем — только заставило
    // бы переподписывать обработчик на каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  if (!user) return null

  const chooseStatus = (status: UserStatus) => {
    gateway.setStatus(status)
    updateLocalStatus(status)
    statusFlyout.close()
  }

  const handleSwitchAccount = async (accountId: number) => {
    setSwitchError('')
    setSwitchingId(accountId)
    try {
      await switchAccount(accountId)
      setOpen(false)
    } catch (err) {
      setSwitchError((err as Error).message)
    } finally {
      setSwitchingId(null)
    }
  }

  const copyId = () => {
    navigator.clipboard.writeText(String(user.id)).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  const canAddAccount = knownAccounts.length < MAX_ACCOUNTS - 1
  const rosterPreview = voiceRoster.slice(0, ROSTER_PREVIEW_LIMIT)
  const rosterOverflow = voiceRoster.length - rosterPreview.length

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
          {/* Блок 1 — мини-профиль */}
          <div
            className="profile-popup-banner"
            style={{
              background:
                user.banner_image ? undefined : user.banner_gradient || undefined,
              backgroundImage: user.banner_image ? `url(${user.banner_image})` : undefined,
            }}
          >
            <Avatar
              name={user.username}
              color={user.avatar_color}
              image={user.avatar_image}
              size={86}
              status={user.status}
              showStatus
            />
            <span className="profile-popup-name">{user.display_name || user.username}</span>
            {!!user.display_name && (
              <span className="profile-popup-username">@{user.username}</span>
            )}
          </div>

          {user.bio && <div className="profile-popup-bio">{user.bio}</div>}

          {/* Блок 2 (опционально) — текущий голосовой/ЛС-звонок */}
          {voice && (
            <div className="profile-popup-voice">
              <div className="profile-popup-voice-room">
                <span className="profile-popup-voice-label">В голосовом канале</span>
                <span className="profile-popup-voice-name">{voice.room.name}</span>
              </div>
              <CallTopic topic={voiceTopic} canEdit={voice.room.kind === 'channel'} />
              {rosterPreview.length > 0 && (
                <div className="profile-popup-voice-roster">
                  {rosterPreview.map((m) => (
                    <Avatar
                      key={m.id}
                      name={m.username}
                      color={m.avatar_color}
                      image={m.avatar_image}
                      size={22}
                    />
                  ))}
                  {rosterOverflow > 0 && (
                    <span className="profile-popup-voice-more">+{rosterOverflow}</span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="profile-popup-divider" />

          {/* Блок 3 — редактирование профиля + выбор статуса */}
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

            <div
              className="status-row-wrap"
              onMouseEnter={statusFlyout.onMouseEnter}
              onMouseLeave={statusFlyout.onMouseLeave}
            >
              <button type="button" className="profile-popup-item status-row">
                <span className={`status-menu-dot ${user.status}`} />
                {STATUS_LABELS[user.status]}
                <ChevronRight size={15} className="status-row-chevron" />
              </button>

              {statusFlyout.open && (
                <div className="status-flyout">
                  <div className="status-flyout-scroll">
                    {OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={`status-flyout-item ${user.status === o.value ? 'active' : ''}`}
                        onClick={() => chooseStatus(o.value)}
                      >
                        <span className="status-flyout-item-head">
                          <span className={`status-menu-dot ${o.value}`} />
                          {o.label}
                        </span>
                        <span className="status-flyout-item-caption">{o.caption}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="profile-popup-divider" />

          {/* Блок 4 — переключение аккаунтов + копирование ID */}
          <div className="profile-popup-menu">
            <div
              className="status-row-wrap"
              onMouseEnter={accountFlyout.onMouseEnter}
              onMouseLeave={accountFlyout.onMouseLeave}
            >
              <button type="button" className="profile-popup-item status-row">
                <Users size={15} /> Переключение между учётными записями
                <ChevronRight size={15} className="status-row-chevron" />
              </button>

              {accountFlyout.open && (
                <div className="status-flyout account-flyout">
                  <div className="status-flyout-scroll">
                    {[
                      { ...user, isActive: true },
                      ...knownAccounts.map((a) => ({ ...a, isActive: false })),
                    ].map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`account-flyout-item ${a.isActive ? 'active' : ''}`}
                        disabled={a.isActive || switchingId !== null}
                        onClick={() => handleSwitchAccount(a.id)}
                      >
                        <Avatar name={a.username} color={a.avatar_color} image={a.avatar_image} size={22} />
                        {a.username}
                        {switchingId === a.id && (
                          <Loader2 size={14} className="spin account-switch-spinner" />
                        )}
                        {a.isActive && <span className="account-flyout-current-dot" />}
                      </button>
                    ))}
                    {switchError && <div className="status-menu-error">{switchError}</div>}

                    {canAddAccount && (
                      <>
                        <div className="profile-popup-divider" />
                        <button
                          type="button"
                          className="account-flyout-item"
                          onClick={() => {
                            setOpen(false)
                            setShowAddAccount(true)
                          }}
                        >
                          <Plus size={15} /> Добавить аккаунт
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button type="button" className="profile-popup-item" onClick={copyId}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Скопировано' : 'Копировать ID'}
            </button>
          </div>
        </div>
      )}

      {showAddAccount && <AddAccountModal onClose={() => setShowAddAccount(false)} />}
    </div>
  )
}
