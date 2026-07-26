import { useLayoutEffect, useRef } from 'react'
import { AtSign, BellRing, Eye, EyeOff, Gavel, UserX, Volume2 } from 'lucide-react'
import { useUserVolume } from '../userVolume'
import { useVoice } from '../voice'

export interface ParticipantContextMenuMember {
  id: number
  username: string
  sharing_screen: boolean
}

export interface ParticipantContextMenuTarget {
  member: ParticipantContextMenuMember
  /** Координаты правого клика — меню всплывает рядом с ним (см. MiniProfilePopup). */
  x: number
  y: number
}

/**
 * Контекстное меню участника голосового канала (правый клик на строке в
 * ChannelSidebar или на тайле в VoiceStage — см. AppShell.contextMenuTarget).
 * Только для голосовых каналов СЕРВЕРА — звонки в личке/группе этого меню не
 * получают (см. план). Закрывается ТОЛЬКО по клику вне себя, намеренно без
 * Escape — так и задумано в задаче.
 */
export default function ParticipantContextMenu({
  target,
  canManageMembers,
  voteDisabled,
  onClose,
  onMention,
  onDisconnect,
  onStartMuteVote,
  onRequestScreenShare,
}: {
  target: ParticipantContextMenuTarget
  /** Право "manage_members" на сервере — от него зависит пункт «Отключить от канала». */
  canManageMembers: boolean
  /** В этом канале уже идёт какое-то голосование — новое начинать нельзя. */
  voteDisabled: boolean
  onClose: () => void
  onMention: (member: ParticipantContextMenuMember) => void
  onDisconnect: (userId: number) => void
  onStartMuteVote: (userId: number) => void
  onRequestScreenShare: (userId: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { getUserVolume, setUserVolume } = useUserVolume()
  const { blockedScreenViewerIds, blockScreenViewer } = useVoice()
  const { member } = target
  const volume = getUserVolume(member.id)
  const isBlocked = blockedScreenViewerIds.has(member.id)

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
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="profile-popup participant-context-menu"
      style={{ left: target.x, top: target.y }}
    >
      <div className="profile-popup-label">{member.username}</div>

      <div className="settings-field participant-menu-volume">
        <div className="settings-field-header">
          <span className="settings-field-label">
            <Volume2 size={14} /> Громкость
          </span>
          <span className="settings-field-value">{Math.round(volume * 100)}%</span>
        </div>
        <div className="settings-field-row">
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={volume}
            onChange={(e) => setUserVolume(member.id, Number(e.target.value))}
          />
        </div>
      </div>

      <div className="profile-popup-divider" />

      <div className="profile-popup-menu">
        <button type="button" className="profile-popup-item" onClick={() => onMention(member)}>
          <AtSign size={15} /> Упомянуть
        </button>

        <button
          type="button"
          className="profile-popup-item"
          onClick={() => blockScreenViewer(member.id, !isBlocked)}
        >
          {isBlocked ? <Eye size={15} /> : <EyeOff size={15} />}
          {isBlocked ? 'Разрешить смотреть демонстрацию' : 'Запретить смотреть демонстрацию'}
        </button>

        {!member.sharing_screen && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => onRequestScreenShare(member.id)}
          >
            <BellRing size={15} /> Запросить демонстрацию
          </button>
        )}

        <button
          type="button"
          className="profile-popup-item"
          disabled={voteDisabled}
          title={voteDisabled ? 'В этом канале уже идёт голосование' : undefined}
          onClick={() => onStartMuteVote(member.id)}
        >
          <Gavel size={15} /> Голосование за мут
        </button>

        {canManageMembers && (
          <>
            <div className="profile-popup-divider" />
            <button
              type="button"
              className="profile-popup-item message-action-danger"
              onClick={() => onDisconnect(member.id)}
            >
              <UserX size={15} /> Отключить от канала
            </button>
          </>
        )}
      </div>
    </div>
  )
}
