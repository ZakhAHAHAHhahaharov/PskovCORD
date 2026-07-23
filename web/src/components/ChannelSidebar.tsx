import { Channel, Member, Server } from '../api'
import Avatar from './Avatar'
import MicButton from './MicButton'
import StatusMenu from './StatusMenu'
import { VoiceState } from './AppShell'
import { VoiceStatus } from './VoiceProvider'

export default function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  members,
  voice,
  voiceStatus,
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
  onSelectText: (c: Channel) => void
  onJoinVoice: (c: Channel) => void
  onLeaveVoice: () => void
  onCreateChannel: (kind: 'text' | 'voice') => void
  onLogout: () => void
}) {
  const textChannels = channels.filter((c) => c.kind === 'text')
  const voiceChannels = channels.filter((c) => c.kind === 'voice')

  const voiceMembersOf = (channelId: number) =>
    members.filter((m) => m.voice_channel === String(channelId))

  return (
    <aside className="channel-sidebar">
      <header className="sidebar-header">
        <span className="sidebar-title">{server ? server.name : 'Нет сервера'}</span>
      </header>

      <div className="channel-scroll">
        {server && (
          <>
            <div className="channel-category">
              <span onClick={() => onCreateChannel('text')} className="cat-label">
                Текстовые каналы
              </span>
              <button
                className="cat-add"
                title="Создать текстовый канал"
                onClick={() => onCreateChannel('text')}
              >
                +
              </button>
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
              <span onClick={() => onCreateChannel('voice')} className="cat-label">
                Голосовые каналы
              </span>
              <button
                className="cat-add"
                title="Создать голосовой канал"
                onClick={() => onCreateChannel('voice')}
              >
                +
              </button>
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
                  {inChannel.map((m) => (
                    <div key={m.id} className="voice-user">
                      <Avatar name={m.username} color={m.avatar_color} size={20} />
                      <span>{m.username}</span>
                    </div>
                  ))}
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
        <StatusMenu />
        <div className="user-panel-actions">
          {voice ? (
            <MicButton />
          ) : (
            <button className="icon-btn" title="Микрофон (войдите в голосовой канал)" disabled>
              🎙️
            </button>
          )}
          <button className="icon-btn" title="Выйти" onClick={onLogout}>
            ⏻
          </button>
        </div>
      </div>
    </aside>
  )
}
