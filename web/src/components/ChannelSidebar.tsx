import { Channel, Member, Server, User } from '../api'
import Avatar from './Avatar'
import MicButton from './MicButton'
import DeafenButton from './DeafenButton'
import CallDuration from './CallDuration'
import CallTopic from './CallTopic'
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
  onLogout,
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
  onLogout: () => void
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

  const isOwner = server?.owner === user.id

  return (
    <aside className="channel-sidebar">
      <header className="sidebar-header">
        <span className="sidebar-title">{server ? server.name : 'Нет сервера'}</span>
      </header>

      <div className="channel-scroll">
        {server && (
          <>
            <div className="channel-category">
              <span
                className="cat-label"
                onClick={isOwner ? () => onCreateChannel('text') : undefined}
              >
                Текстовые каналы
              </span>
              {isOwner && (
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
                onClick={isOwner ? () => onCreateChannel('voice') : undefined}
              >
                Голосовые каналы
              </span>
              {isOwner && (
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
                      voice?.channel.id === c.id ? 'active' : ''
                    }`}
                    onClick={() => onJoinVoice(c)}
                  >
                    <span className="channel-icon">🔊</span>
                    <span className="channel-name">{c.name}</span>
                  </button>
                  {inChannel.length > 0 && (
                    <div className="voice-call-info">
                      {c.call_started_at != null && (
                        <CallDuration startedAt={c.call_started_at} />
                      )}
                      <CallTopic topic={c.topic} canEdit={voice?.channel.id === c.id} />
                    </div>
                  )}
                  {inChannel.map((m) => {
                    const speaking = speakingUserIds.has(m.id)
                    const mic = micStateOf(m)
                    return (
                      <div key={m.id} className="voice-user">
                        <Avatar name={m.username} color={m.avatar_color} size={20} speaking={speaking} />
                        <span className={speaking ? 'speaking' : ''}>{m.username}</span>
                        <span className="voice-user-icons">
                          {mic.muted && <span title="Микрофон выключен">🔇</span>}
                          {mic.deafened && <span title="Не слышит участников">🔕</span>}
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

      {voice && (
        <div className="voice-connected">
          <div className="voice-connected-info">
            <span className="voice-signal">
              {voiceStatus === 'connected' ? '📶 Голос подключён' : '⏳ Подключение…'}
            </span>
            <span className="voice-connected-channel">🔊 {voice.channel.name}</span>
          </div>
          <button className="voice-disconnect" title="Отключиться" onClick={onLeaveVoice}>
            ⏻
          </button>
        </div>
      )}

      <div className="user-panel">
        <div className="user-panel-id">
          <Avatar
            name={user.username}
            color={user.avatar_color}
            size={32}
            online
            showStatus
            speaking={speakingUserIds.has(user.id)}
          />
          <div className="user-panel-names">
            <span className="user-panel-username">{user.username}</span>
            <span className="user-panel-status">В сети</span>
          </div>
        </div>
        <div className="user-panel-actions">
          {voice ? (
            <>
              <MicButton />
              <DeafenButton />
            </>
          ) : (
            <>
              <button className="icon-btn" title="Микрофон (войдите в голосовой канал)" disabled>
                🎙️
              </button>
              <button className="icon-btn" title="Звук (войдите в голосовой канал)" disabled>
                🎧
              </button>
            </>
          )}
          <button className="icon-btn" title="Выйти" onClick={onLogout}>
            ⏻
          </button>
        </div>
      </div>
    </aside>
  )
}
