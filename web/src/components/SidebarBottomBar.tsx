import {
  Wifi, WifiOff, Loader2, PhoneOff, Mic, MicOff, Headphones, HeadphoneOff, Circle,
  Settings, Volume2,
} from 'lucide-react'
import { User } from '../api'
import MicButton from './MicButton'
import StatusMenu from './StatusMenu'
import DeafenButton from './DeafenButton'
import { useVoice } from '../voice'
import { useSettings } from '../settings'
import { playToggleSound } from '../sounds'
import { VoiceState } from './AppShell'
import { VoiceStatus } from './VoiceProvider'
import { VoiceRosterMember } from './VoiceStage'

function pingColor(ms: number): string {
  if (ms < 80) return 'var(--green)'
  if (ms < 180) return 'var(--yellow)'
  return 'var(--red)'
}

/** Нижняя панель сайдбара (голос-статус звонка + свой статус/аватар +
 * мик/дефен/демка/настройки) — общая для ChannelSidebar (сервер) и
 * HomeSidebar (личка/группы): звонок может идти в обоих режимах, а доступ
 * к статусу/настройкам нужен независимо от того, что выбрано в rail слева. */
export default function SidebarBottomBar({
  voice,
  voiceRoster,
  voiceTopic,
  voiceStatus,
  user,
  onLeaveVoice,
  onOpenSettings,
  onOpenProfile,
}: {
  voice: VoiceState | null
  /** Кто ещё сейчас в том же звонке, что и мы — для Блока 2 в StatusMenu. */
  voiceRoster: VoiceRosterMember[]
  /** Статус текущего звонка (только у серверных голосовых каналов). */
  voiceTopic: string | null
  voiceStatus: VoiceStatus
  user: User
  onLeaveVoice: () => void
  onOpenSettings: () => void
  onOpenProfile: () => void
}) {
  const { speakingUserIds, pingMs } = useVoice()
  // Вне звонка мьют/дефен — просто предпочтение на будущий вход (см. voice.ts
  // useVoiceMesh — читает его как стартовое состояние), кнопки здесь не
  // трогают ничего в WebRTC вообще, в отличие от MicButton/DeafenButton.
  const { preferMicMuted, preferDeafened, setPreferMicMuted, setPreferDeafened } = useSettings()

  const toggleMicPreference = () => {
    const next = !preferMicMuted
    playToggleSound(preferMicMuted) // preferMicMuted=true => сейчас включаем обратно
    setPreferMicMuted(next)
    // Как в Discord: включение микрофона снимает дефен.
    if (!next && preferDeafened) setPreferDeafened(false)
  }

  const toggleDeafenPreference = () => {
    const next = !preferDeafened
    playToggleSound(preferDeafened)
    setPreferDeafened(next)
    // Дефен глушит и микрофон — не звучит просить "не слышать", но говорить.
    if (next) setPreferMicMuted(true)
  }

  return (
    <div className="sidebar-bottom">
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
              <Volume2 size={12} /> {voice.room.name}
            </span>
          </div>
          <button className="voice-disconnect" title="Отключиться" onClick={onLeaveVoice}>
            <PhoneOff size={17} />
          </button>
        </div>
      )}

      <div className="user-panel">
        <StatusMenu
          speaking={speakingUserIds.has(user.id)}
          onOpenProfile={onOpenProfile}
          voice={voice}
          voiceRoster={voiceRoster}
          voiceTopic={voiceTopic}
          voiceStatus={voiceStatus}
        />
        <div className="user-panel-actions">
          {voice ? (
            <>
              <MicButton />
              <DeafenButton />
            </>
          ) : (
            <>
              <button
                className={`icon-btn ${preferMicMuted ? 'muted' : ''}`}
                title={preferMicMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                onClick={toggleMicPreference}
              >
                {preferMicMuted ? <MicOff size={17} /> : <Mic size={17} />}
              </button>
              <button
                className={`icon-btn ${preferDeafened ? 'muted' : ''}`}
                title={preferDeafened ? 'Включить звук' : 'Отключить звук (не слышать участников)'}
                onClick={toggleDeafenPreference}
              >
                {preferDeafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
              </button>
            </>
          )}
          <button className="icon-btn" title="Настройки" onClick={onOpenSettings}>
            <Settings size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}
