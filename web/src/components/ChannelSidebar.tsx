import { Volume2, MicOff, HeadphoneOff, Monitor, Settings } from 'lucide-react'
import { Channel, Member, Server, User } from '../api'
import Avatar from './Avatar'
import CallDuration from './CallDuration'
import CallTopic from './CallTopic'
import SidebarBottomBar from './SidebarBottomBar'
import { useVoice } from '../voice'
import { VoiceState } from './AppShell'
import { VoiceStatus } from './VoiceProvider'

export default function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  members,
  voice,
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
}: {
  server: Server | null
  channels: Channel[]
  activeChannelId: number | null
  members: Member[]
  voice: VoiceState | null
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
}) {
  const { speakingUserIds, muted, deafened } = useVoice()
  // Для себя — локальное состояние mesh'а (мгновенный отклик на клик);
  // для остальных — то, что пришло в members (видно всем, даже не
  // подключённым к этому голосовому каналу вообще).
  const micStateOf = (member: Member): { muted: boolean; deafened: boolean } =>
    member.id === user.id ? { muted, deafened } : { muted: member.muted, deafened: member.deafened }
  const textChannels = channels.filter((c) => c.kind === 'text')
  const voiceChannels = channels.filter((c) => c.kind === 'voice')

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
              return (
                <div key={c.id} className="voice-channel-block">
                  <button
                    className={`channel-item ${
                      voice?.room.id === c.id ? 'active' : ''
                    }`}
                    onClick={() => onJoinVoice(c)}
                  >
                    <span className="channel-icon">
                      <Volume2 size={15} />
                    </span>
                    <span className="channel-name">{c.name}</span>
                  </button>
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
                    return (
                      <div key={m.id} className="voice-user">
                        <Avatar
                          name={m.username}
                          color={m.avatar_color}
                          image={m.avatar_image}
                          size={20}
                          speaking={speaking}
                        />
                        <span className={speaking ? 'speaking' : ''}>{m.username}</span>
                        {m.sharing_screen && (
                          <button
                            className="demo-badge"
                            title={`Смотреть демонстрацию экрана — ${m.username}`}
                            onClick={() => onWatchScreen(m)}
                          >
                            <Monitor size={11} /> демка
                          </button>
                        )}
                        <span className="voice-user-icons">
                          {mic.muted && (
                            <span title="Микрофон выключен">
                              <MicOff size={13} />
                            </span>
                          )}
                          {mic.deafened && (
                            <span title="Не слышит участников">
                              <HeadphoneOff size={13} />
                            </span>
                          )}
                        </span>
                      </div>
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
        voiceStatus={voiceStatus}
        user={user}
        onLeaveVoice={onLeaveVoice}
        onOpenSettings={onOpenSettings}
        onOpenProfile={onOpenProfile}
      />
    </aside>
  )
}
