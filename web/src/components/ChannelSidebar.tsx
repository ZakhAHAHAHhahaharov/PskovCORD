import { MouseEvent as ReactMouseEvent } from 'react'
import { Volume2, MicOff, HeadphoneOff, Monitor, Settings, Pin } from 'lucide-react'
import { Channel, Member, Server, User } from '../api'
import { styledNameProps } from '../nameStyle'
import { VoiceRosterMember } from './VoiceStage'
import Avatar from './Avatar'
import CallDuration from './CallDuration'
import CallTopic from './CallTopic'
import SidebarBottomBar from './SidebarBottomBar'
import { useVoice } from '../voice'
import { VoiceState } from './AppShell'
import { VoiceStatus } from './VoiceProvider'
import { useLongPress } from '../hooks/useLongPress'
import { maskName, useHiddenNames } from '../hiddenNames'

function VoiceUserRow({
  member: m,
  channelId,
  speaking,
  muted,
  deafened,
  canOpenMenu,
  masked,
  onOpenParticipantProfile,
  onParticipantContextMenu,
  onWatchScreen,
}: {
  member: Member
  channelId: number
  speaking: boolean
  muted: boolean
  deafened: boolean
  canOpenMenu: boolean
  /** Включено «Скрыть имена» для этого канала (см. ChannelContextMenu) —
   * ник виден только себе, остальным этот же список выглядит как обычно. */
  masked: boolean
  onOpenParticipantProfile?: (member: Member, e: ReactMouseEvent) => void
  onParticipantContextMenu?: (
    member: Member,
    e: ReactMouseEvent,
    room: { kind: 'channel'; id: number },
  ) => void
  onWatchScreen: (member: Member) => void
}) {
  // Long-press — тач-аналог правого клика ниже, тот же колбэк (читает только
  // .clientX/.clientY, см. AppShell.openParticipantContextMenu).
  const longPress = useLongPress((point) => {
    if (!canOpenMenu) return
    onParticipantContextMenu!(m, point as unknown as ReactMouseEvent, { kind: 'channel', id: channelId })
  })
  return (
    <button
      type="button"
      className="voice-user"
      onClick={(e) => onOpenParticipantProfile?.(m, e)}
      onContextMenu={
        canOpenMenu
          ? (e) => {
              e.preventDefault()
              onParticipantContextMenu!(m, e, { kind: 'channel', id: channelId })
            }
          : undefined
      }
      {...(canOpenMenu ? longPress : {})}
    >
      <Avatar
        name={m.username}
        color={m.avatar_color}
        image={m.avatar_image}
        size={20}
        speaking={speaking}
      />
      <span
        className={`${speaking ? 'speaking' : ''} ${styledNameProps(m).className}`}
        style={styledNameProps(m).style}
      >
        {masked ? maskName(m.username) : m.username}
      </span>
      {m.sharing_screen && (
        <span
          className="demo-badge"
          title={`Смотреть демонстрацию экрана — ${masked ? maskName(m.username) : m.username}`}
          onClick={(e) => {
            e.stopPropagation()
            onWatchScreen(m)
          }}
        >
          <Monitor size={11} /> демка
        </span>
      )}
      <span className="voice-user-icons">
        {muted && (
          <span title="Микрофон выключен">
            <MicOff size={13} />
          </span>
        )}
        {deafened && (
          <span title="Не слышит участников">
            <HeadphoneOff size={13} />
          </span>
        )}
      </span>
    </button>
  )
}

export default function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  members,
  voice,
  voiceRoster,
  voiceTopic,
  voiceStatus,
  user,
  onSelectText,
  onJoinVoice,
  onLeaveVoice,
  onCreateChannel,
  onOpenSettings,
  onOpenProfile,
  onWatchScreen,
  onOpenServerSettings,
  onParticipantContextMenu,
  onOpenParticipantProfile,
  onChannelContextMenu,
}: {
  server: Server | null
  channels: Channel[]
  activeChannelId: number | null
  members: Member[]
  voice: VoiceState | null
  /** Кто ещё сейчас в том же звонке, что и мы — для Блока 2 в StatusMenu. */
  voiceRoster: VoiceRosterMember[]
  /** Статус текущего звонка (только у серверных голосовых каналов). */
  voiceTopic: string | null
  voiceStatus: VoiceStatus
  user: User
  onSelectText: (c: Channel) => void
  onJoinVoice: (c: Channel) => void
  onLeaveVoice: () => void
  onCreateChannel: (kind: 'text' | 'voice') => void
  onOpenSettings: () => void
  onOpenProfile: () => void
  /** Клик по бейджу «демка» рядом с ником — открыть демонстрацию этого
   * участника (с автоподключением к его каналу, если мы не там). */
  onWatchScreen: (member: Member) => void
  /** Шестерёнка у названия сервера — редактор сервера поверх всей страницы. */
  onOpenServerSettings: () => void
  /** Правый клик на участнике голосового канала — открывается для ЛЮБОГО
   * канала сервера, даже если мы сами сейчас не в голосе вообще (см.
   * AppShell.contextMenuTarget) — AppShell сам решает, какие пункты внутри
   * доступны, по тому, подключены ли мы именно к этому каналу. */
  onParticipantContextMenu?: (
    member: Member,
    e: ReactMouseEvent,
    room: { kind: 'channel'; id: number },
  ) => void
  /** Левый клик на участнике голосового канала — открыть его мини-профиль
   * (см. MembersList.onOpenProfile — тот же попап, тот же коллбэк из AppShell). */
  onOpenParticipantProfile?: (member: Member, e: ReactMouseEvent) => void
  /** Правый клик на самом голосовом канале (не на участнике) — меню
   * приглашения/закрепления/ссылки/статуса/скрытия имён, см. ChannelContextMenu. */
  onChannelContextMenu?: (channel: Channel, e: ReactMouseEvent) => void
}) {
  const { speakingUserIds, muted, deafened } = useVoice()
  const { isHidden } = useHiddenNames()
  // Для себя — локальное состояние mesh'а (мгновенный отклик на клик);
  // для остальных — то, что пришло в members (видно всем, даже не
  // подключённым к этому голосовому каналу вообще).
  const micStateOf = (member: Member): { muted: boolean; deafened: boolean } =>
    member.id === user.id ? { muted, deafened } : { muted: member.muted, deafened: member.deafened }
  const textChannels = channels.filter((c) => c.kind === 'text')
  const pinnedIds = server?.my_settings.pinned_channel_ids ?? []
  // Закреплённые — первыми, сверху вниз, порядок закрепления; остальные —
  // как пришли с сервера (позиция канала), см. ChannelContextMenu «Закрепить
  // канал вверху».
  const voiceChannels = [...channels.filter((c) => c.kind === 'voice')].sort((a, b) => {
    const ai = pinnedIds.indexOf(a.id)
    const bi = pinnedIds.indexOf(b.id)
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  const voiceMembersOf = (channelId: number) =>
    members.filter((m) => m.voice_channel === String(channelId))

  // Что можно на этом сервере, решают роли (см. chat/roles.py) — владелец
  // просто получает все права разом, отдельной ветки под него нет.
  const perms = server?.my_permissions
  const canManageChannels = !!perms?.manage_channels
  // Редактор сервера открывается, если есть хоть одна доступная вкладка.
  const canEditServer =
    !!perms && (perms.manage_server || perms.manage_roles || perms.manage_members)

  return (
    <aside className="channel-sidebar">
      <header className="sidebar-header">
        <span className="sidebar-title">{server ? server.name : 'Нет сервера'}</span>
        {canEditServer && (
          <button
            type="button"
            className="icon-btn"
            title="Редактор сервера"
            onClick={onOpenServerSettings}
          >
            <Settings size={16} />
          </button>
        )}
      </header>

      <div className="channel-scroll" style={{ paddingBottom: voice ? 116 : 60 }}>
        {server && (
          <>
            <div className="channel-category">
              <span
                className="cat-label"
                onClick={canManageChannels ? () => onCreateChannel('text') : undefined}
              >
                Текстовые каналы
              </span>
              {canManageChannels && (
                <button
                  className="cat-add"
                  title="Создать текстовый канал"
                  onClick={() => onCreateChannel('text')}
                >
                  +
                </button>
              )}
            </div>
            {textChannels.map((c) => (
              <button
                key={c.id}
                className={`channel-item ${activeChannelId === c.id ? 'active' : ''}`}
                onClick={() => onSelectText(c)}
              >
                <span className="channel-icon">#</span>
                <span className="channel-name">{c.name}</span>
              </button>
            ))}

            <div className="channel-category">
              <span
                className="cat-label"
                onClick={canManageChannels ? () => onCreateChannel('voice') : undefined}
              >
                Голосовые каналы
              </span>
              {canManageChannels && (
                <button
                  className="cat-add"
                  title="Создать голосовой канал"
                  onClick={() => onCreateChannel('voice')}
                >
                  +
                </button>
              )}
            </div>
            {voiceChannels.map((c) => {
              const inChannel = voiceMembersOf(c.id)
              const isMyVoiceChannel = voice?.room.kind === 'channel' && voice.room.id === c.id
              const isPinned = pinnedIds.includes(c.id)
              const masked = isHidden(c.id)
              return (
                <div key={c.id} className="voice-channel-block">
                  <button
                    className={`channel-item ${
                      voice?.room.id === c.id ? 'active' : ''
                    }`}
                    onClick={() => onJoinVoice(c)}
                    onContextMenu={
                      onChannelContextMenu
                        ? (e) => {
                            e.preventDefault()
                            onChannelContextMenu(c, e)
                          }
                        : undefined
                    }
                  >
                    <span className={`channel-icon${isMyVoiceChannel ? ' in-voice' : ''}`}>
                      <Volume2 size={15} />
                    </span>
                    <span className="channel-name">{c.name}</span>
                    {isPinned && <Pin size={12} className="channel-pin-badge" />}
                  </button>
                  {c.status && <div className="voice-channel-status">{c.status}</div>}
                  {inChannel.length > 0 && (
                    <div className="voice-call-info">
                      {c.call_started_at != null && (
                        <CallDuration startedAt={c.call_started_at} />
                      )}
                      <CallTopic topic={c.topic} canEdit={voice?.room.id === c.id} />
                    </div>
                  )}
                  {inChannel.map((m) => {
                    const speaking = speakingUserIds.has(m.id)
                    const mic = micStateOf(m)
                    const canOpenMenu = m.id !== user.id && !!onParticipantContextMenu
                    return (
                      <VoiceUserRow
                        key={m.id}
                        member={m}
                        channelId={c.id}
                        speaking={speaking}
                        muted={mic.muted}
                        deafened={mic.deafened}
                        canOpenMenu={canOpenMenu}
                        masked={masked}
                        onOpenParticipantProfile={onOpenParticipantProfile}
                        onParticipantContextMenu={onParticipantContextMenu}
                        onWatchScreen={onWatchScreen}
                      />
                    )
                  })}
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Прибита к низу absolute и шире колонки сайдбара (см. .sidebar-bottom в
          SidebarBottomBar) — иначе 5 иконок действий не помещаются рядом с
          ником+статусом и съезжают друг на друга. Раз она "плывёт" поверх
          main, .channel-scroll выше получает нижний паддинг под её высоту
          (см. inline style). */}
      <SidebarBottomBar
        voice={voice}
        voiceRoster={voiceRoster}
        voiceTopic={voiceTopic}
        voiceStatus={voiceStatus}
        user={user}
        onLeaveVoice={onLeaveVoice}
        onOpenSettings={onOpenSettings}
        onOpenProfile={onOpenProfile}
      />
    </aside>
  )
}
