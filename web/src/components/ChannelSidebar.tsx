import {
  Volume2,
  MicOff,
  HeadphoneOff,
  Wifi,
  WifiOff,
  Loader2,
  PhoneOff,
  Mic,
  Headphones,
  Monitor,
  Circle,
  Settings,
} from 'lucide-react'
import { Channel, Member, Server, User } from '../api'
import Avatar from './Avatar'
import MicButton from './MicButton'
import StatusMenu from './StatusMenu'
import DeafenButton from './DeafenButton'
import ScreenShareButton from './ScreenShareButton'
import CallDuration from './CallDuration'
import CallTopic from './CallTopic'
import { useVoice } from '../voice'
import { VoiceState } from './AppShell'
import { VoiceStatus } from './VoiceProvider'

function pingColor(ms: number): string {
  if (ms < 80) return 'var(--green)'
  if (ms < 180) return 'var(--yellow)'
  return 'var(--red)'
}

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
  onWatchScreen,
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
  /** Клик по бейджу «демка» рядом с ником — открыть демонстрацию этого
   * участника (с автоподключением к его каналу, если мы не там). */
  onWatchScreen: (member: Member) => void
}) {
  const { speakingUserIds, muted, deafened, pingMs } = useVoice()
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

      {voice && (
        <div className="voice-connected">
          <div className="voice-connected-info">
            <span
              className={`voice-signal ${
                voiceStatus === 'reconnecting' ? 'warn' : voiceStatus === 'failed' ? 'error' : ''
              }`}
            >
              {voiceStatus === 'connected' && (
                <>
                  <Wifi size={14} /> Голос подключён
                </>
              )}
              {voiceStatus === 'connecting' && (
                <>
                  <Loader2 size={14} className="spin" /> Подключение…
                </>
              )}
              {voiceStatus === 'reconnecting' && (
                <>
                  <Loader2 size={14} className="spin" /> Переподключение…
                </>
              )}
              {voiceStatus === 'failed' && (
                <>
                  <WifiOff size={14} /> Нет связи
                </>
              )}
              {voiceStatus === 'connected' && pingMs != null && (
                <span className="voice-ping">
                  <Circle size={8} fill={pingColor(pingMs)} color={pingColor(pingMs)} /> {pingMs} мс
                </span>
              )}
            </span>
            <span className="voice-connected-channel">
              <Volume2 size={12} /> {voice.channel.name}
            </span>
          </div>
          <button className="voice-disconnect" title="Отключиться" onClick={onLeaveVoice}>
            <PhoneOff size={17} />
          </button>
        </div>
      )}

      <div className="user-panel">
        <StatusMenu speaking={speakingUserIds.has(user.id)} />
        <div className="user-panel-actions">
          {voice ? (
            <>
              <MicButton />
              <DeafenButton />
              <ScreenShareButton />
            </>
          ) : (
            <>
              <button className="icon-btn" title="Микрофон (войдите в голосовой канал)" disabled>
                <Mic size={17} />
              </button>
              <button className="icon-btn" title="Звук (войдите в голосовой канал)" disabled>
                <Headphones size={17} />
              </button>
              <button className="icon-btn" title="Демонстрация экрана (войдите в голосовой канал)" disabled>
                <Monitor size={17} />
              </button>
            </>
          )}
          <button className="icon-btn" title="Настройки" onClick={onOpenSettings}>
            <Settings size={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}
