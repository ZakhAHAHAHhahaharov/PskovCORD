import { useLayoutEffect, useRef } from 'react'
import {
  AlarmClock, AtSign, BellRing, Eye, EyeOff, Gavel, Tag, UserX, Volume2, VolumeX,
} from 'lucide-react'
import { useLocalMute } from '../localMute'
import { useNickname } from '../nicknames'
import { useUserVolume } from '../userVolume'
import { useVoice } from '../voice'

export interface ParticipantContextMenuMember {
  id: number
  username: string
  sharing_screen: boolean
  muted: boolean
  deafened: boolean
}

export interface ParticipantContextMenuTarget {
  member: ParticipantContextMenuMember
  /** Координаты правого клика — меню всплывает рядом с ним (см. MiniProfilePopup). */
  x: number
  y: number
  /** Голосовая комната, в которой находится member — канал сервера или звонок
   * в личке/группе. Голосование за мут и запрос демонстрации бэкенд
   * поддерживает только для серверных каналов (см. chat/consumers.py
   * _own_voice_channel_server/_handle_voice_request_screen_share), поэтому
   * для звонков в личке/группе эти пункты вообще не показываются. */
  room: { kind: 'channel' | 'conversation'; id: number | string }
}

/**
 * Контекстное меню участника голосового канала — правый клик на строке в
 * ChannelSidebar (работает даже если сам не подключён к этому каналу) или на
 * тайле в VoiceStage (сервер ИЛИ звонок в личке/группе — см.
 * AppShell.contextMenuTarget). Закрывается ТОЛЬКО по клику вне себя,
 * намеренно без Escape — так и задумано в задаче.
 */
export default function ParticipantContextMenu({
  target,
  canManageMembers,
  canManageNicknames,
  canStartMuteVote,
  canRequestScreenShare,
  voteDisabled,
  voiceActionsEnabled,
  onClose,
  onMention,
  onDisconnect,
  onStartMuteVote,
  onRequestScreenShare,
  onWakeUser,
  onSetServerNickname,
}: {
  target: ParticipantContextMenuTarget
  /** Право "manage_members" на сервере — от него зависит пункт «Отключить от канала». */
  canManageMembers: boolean
  /** "manage_nicknames" — менять никнейм ДРУГИХ участников на этом сервере. */
  canManageNicknames: boolean
  /** "start_mute_vote" / "request_screen_share" — соответствующие пункты
   * прячем целиком, а не дизейблим: их отсутствие — решение роли, а не
   * временное состояние вроде «ты не подключён к каналу». */
  canStartMuteVote: boolean
  canRequestScreenShare: boolean
  /** В этом канале уже идёт какое-то голосование — новое начинать нельзя. */
  voteDisabled: boolean
  /** Мы сами сейчас ПОЛНОСТЬЮ подключены именно к этой голосовой комнате —
   * без этого голосование за мут / запрос демонстрации / блокировка
   * зрителя демонстрации технически не сработают (см. AppShell). Меню
   * можно открыть и без этого (см. target.room), но сами действия — нет. */
  voiceActionsEnabled: boolean
  onClose: () => void
  onMention: (member: ParticipantContextMenuMember) => void
  onDisconnect: (userId: number) => void
  onStartMuteVote: (userId: number) => void
  onRequestScreenShare: (userId: number) => void
  onWakeUser: (userId: number) => void
  /** Никнейм участника НА СЕРВЕРЕ — виден всем (в отличие от приватного
   * никнейма друга, см. nicknames.ts). */
  onSetServerNickname: (userId: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { getUserVolume, setUserVolume } = useUserVolume()
  const { isLocallyMuted, setLocallyMuted } = useLocalMute()
  const { blockedScreenViewerIds, blockScreenViewer } = useVoice()
  const { member } = target
  const nickname = useNickname(member.id)
  const isServerChannel = target.room.kind === 'channel'
  const volume = getUserVolume(member.id)
  const locallyMuted = isLocallyMuted(member.id)
  const isBlocked = blockedScreenViewerIds.has(member.id)
  const disabledTitle = !voiceActionsEnabled
    ? 'Нужно быть полностью подключённым к этому голосовому каналу'
    : undefined

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
      <div className="profile-popup-label">{nickname || member.username}</div>

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
        <button
          type="button"
          className="profile-popup-item"
          onClick={() => setLocallyMuted(member.id, !locallyMuted)}
        >
          {locallyMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          {locallyMuted ? 'Включить звук участника' : 'Отключить звук участника'}
        </button>

        <button type="button" className="profile-popup-item" onClick={() => onMention(member)}>
          <AtSign size={15} /> Упомянуть
        </button>

        <button
          type="button"
          className="profile-popup-item"
          disabled={!voiceActionsEnabled}
          title={disabledTitle}
          onClick={() => blockScreenViewer(member.id, !isBlocked)}
        >
          {isBlocked ? <Eye size={15} /> : <EyeOff size={15} />}
          {isBlocked ? 'Разрешить смотреть демонстрацию' : 'Запретить смотреть демонстрацию'}
        </button>

        {isServerChannel && canRequestScreenShare && !member.sharing_screen && (
          <button
            type="button"
            className="profile-popup-item"
            disabled={!voiceActionsEnabled}
            title={disabledTitle}
            onClick={() => onRequestScreenShare(member.id)}
          >
            <BellRing size={15} /> Запросить демонстрацию
          </button>
        )}

        {isServerChannel && canStartMuteVote && (
          <button
            type="button"
            className="profile-popup-item"
            disabled={voteDisabled || !voiceActionsEnabled}
            title={
              !voiceActionsEnabled
                ? disabledTitle
                : voteDisabled
                  ? 'В этом канале уже идёт голосование'
                  : undefined
            }
            onClick={() => onStartMuteVote(member.id)}
          >
            <Gavel size={15} /> Голосование за мут
          </button>
        )}

        {isServerChannel && (
          <button
            type="button"
            className="profile-popup-item"
            disabled={!voiceActionsEnabled || !(member.muted || member.deafened)}
            title={
              !voiceActionsEnabled
                ? disabledTitle
                : !(member.muted || member.deafened)
                  ? 'Работает, только если у участника выключен микрофон или звук'
                  : undefined
            }
            onClick={() => onWakeUser(member.id)}
          >
            <AlarmClock size={15} /> Разбудить мальчика
          </button>
        )}

        {isServerChannel && canManageNicknames && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => {
              onSetServerNickname(member.id)
              onClose()
            }}
          >
            <Tag size={15} /> Никнейм на сервере
          </button>
        )}

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
