import { useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import { Maximize2, Minimize2, Monitor, MicOff, HeadphoneOff, X, Eye } from 'lucide-react'
import { Channel, Member } from '../api'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'
import { useSettings } from '../settings'
import { useVoice } from '../voice'

/** Живой `<video>`, привязанный к MediaStream по ref — не пересоздаётся при
 * смене раскладки (grid ⇄ развёрнуто), поток не прерывается. */
function StreamVideo({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const { outputVolume } = useSettings()
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  useEffect(() => {
    if (ref.current) ref.current.volume = outputVolume
  }, [outputVolume])
  return <video ref={ref} autoPlay playsInline muted={muted} />
}

function ParticipantTile({
  member,
  speaking,
  muted,
  deafened,
  onOpenProfile,
}: {
  member: Member
  speaking: boolean
  muted: boolean
  deafened: boolean
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  return (
    <div className="participant-tile">
      <button
        type="button"
        className="avatar-trigger"
        onClick={(e) => onOpenProfile(member, e)}
      >
        <Avatar
          name={member.username}
          color={member.avatar_color}
          image={member.avatar_image}
          size={64}
          speaking={speaking}
        />
      </button>
      <span
        className="participant-tile-name profile-trigger-name"
        onClick={(e) => onOpenProfile(member, e)}
      >
        {member.username}
      </span>
      <span className="participant-tile-icons">
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
      {member.sharing_screen && (
        <span className="demo-badge participant-tile-badge">
          <Monitor size={11} /> демка
        </span>
      )}
    </div>
  )
}

function ScreenPreviewTile({
  username,
  stream,
  own,
  deafened,
  onWatch,
  onExpand,
  onStopWatching,
}: {
  username: string
  stream: MediaStream | null
  own: boolean
  deafened: boolean
  onWatch: () => void
  onExpand: () => void
  onStopWatching: () => void
}) {
  return (
    <div className="screen-preview-tile" onClick={stream ? onExpand : undefined}>
      {stream ? (
        <StreamVideo stream={stream} muted={own || deafened} />
      ) : (
        <div className="screen-preview-placeholder">
          <Monitor size={28} />
        </div>
      )}
      <span className="screen-tile-label">
        <Monitor size={13} /> {own ? 'Ваша демонстрация' : `Демонстрация — ${username}`}
      </span>
      {!stream && !own && (
        <button
          className="screen-watch-btn"
          onClick={(e) => {
            e.stopPropagation()
            onWatch()
          }}
        >
          <Eye size={16} /> Смотреть демку
        </button>
      )}
      {stream && !own && (
        <button
          className="screen-stop-watch-btn"
          title="Перестать смотреть"
          onClick={(e) => {
            e.stopPropagation()
            onStopWatching()
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

/**
 * Главный экран голосового канала (замена текстового чата в main, пока
 * выбран голосовой канал). Показывает участников и активные демонстрации
 * экрана. Демонстрацию нужно явно "посмотреть" (кнопка) — авто-подписки нет.
 * Клик на превью раскрывает демонстрацию на весь блок; сворачивание не
 * прерывает поток (тот же MediaStream, другая раскладка). См. родительский
 * AppShell.handleWatchScreen — единая точка входа и для бейджа в сайдбаре,
 * и для клика по превью здесь.
 */
export default function VoiceStage({
  channel,
  members,
  selfUserId,
  pendingWatchUserId,
  onConsumedPendingWatch,
  onRequestWatch,
  onOpenProfile,
}: {
  channel: Channel
  members: Member[]
  selfUserId: number
  /** userId, которого нужно автоматически начать смотреть и развернуть, как
   * только его демонстрация станет доступна (после клика по бейджу/тайлу). */
  pendingWatchUserId: number | null
  onConsumedPendingWatch: () => void
  onRequestWatch: (userId: number) => void
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  const {
    speakingUserIds,
    muted: selfMuted,
    deafened,
    availableScreenUserIds,
    screenShares,
    ownScreenStream,
    isSharingScreen,
    watchScreen,
    unwatchScreen,
  } = useVoice()

  const [expandedUserId, setExpandedUserId] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement === containerRef.current) {
      document.exitFullscreen().catch(() => {})
    } else {
      containerRef.current?.requestFullscreen().catch(() => {})
    }
  }

  // Автопросмотр по внешнему запросу (бейдж «демка» или клик по чужому
  // превью) — как только демонстрация реально доступна в этой SFU-комнате.
  useEffect(() => {
    if (pendingWatchUserId == null) return
    if (pendingWatchUserId === selfUserId) {
      setExpandedUserId(selfUserId)
      onConsumedPendingWatch()
      return
    }
    if (availableScreenUserIds.has(pendingWatchUserId)) {
      watchScreen(pendingWatchUserId)
      setExpandedUserId(pendingWatchUserId)
      onConsumedPendingWatch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWatchUserId, availableScreenUserIds, selfUserId])

  const roster = members.filter((m) => m.voice_channel === String(channel.id))
  // Кто демонстрирует: свой стрим — сразу по факту isSharingScreen (без
  // ожидания round-trip через presence), остальные — по presence-флагу
  // (виден даже если мы ещё не забрали их producer через SFU).
  const sharingOthers = roster.filter((m) => m.id !== selfUserId && m.sharing_screen)

  const nameOf = (uid: number) => members.find((m) => m.id === uid)?.username ?? `Участник ${uid}`

  // Сколько всего тайлов в сетке (участники + свой показ + чужие демки) —
  // от этого зависит число колонок: мало тайлов -> они большие и заполняют
  // всё пространство main (как в Discord), много -> сетка мельче.
  const tileCount = roster.length + (isSharingScreen ? 1 : 0) + sharingOthers.length
  const gridCols = Math.max(1, Math.ceil(Math.sqrt(tileCount || 1)))

  const expandedStream =
    expandedUserId == null
      ? null
      : expandedUserId === selfUserId
        ? ownScreenStream
        : screenShares.get(expandedUserId) ?? null

  return (
    <div ref={containerRef} className={`voice-stage ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <header className="voice-stage-header">
        <span className="voice-stage-title">
          <Monitor size={16} /> {channel.name}
        </span>
        <button
          className="icon-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Свернуть из полноэкранного режима' : 'На весь экран'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </header>

      {expandedUserId != null ? (
        <div className="voice-stage-expanded">
          <div className="voice-stage-expanded-bar">
            <span className="screen-tile-label">
              <Monitor size={13} />{' '}
              {expandedUserId === selfUserId ? 'Ваша демонстрация' : `Демонстрация — ${nameOf(expandedUserId)}`}
            </span>
            <div className="voice-stage-expanded-actions">
              {expandedUserId !== selfUserId && (
                <button
                  className="icon-btn"
                  title="Перестать смотреть"
                  onClick={() => {
                    unwatchScreen(expandedUserId)
                    setExpandedUserId(null)
                  }}
                >
                  <X size={16} />
                </button>
              )}
              <button
                className="icon-btn"
                title="Свернуть"
                onClick={() => setExpandedUserId(null)}
              >
                <Minimize2 size={16} />
              </button>
            </div>
          </div>
          <div
            className="voice-stage-expanded-video"
            title="Свернуть"
            onClick={() => setExpandedUserId(null)}
          >
            {expandedStream ? (
              <StreamVideo
                stream={expandedStream}
                muted={expandedUserId === selfUserId || deafened}
              />
            ) : (
              <div className="screen-preview-placeholder">
                <Monitor size={40} />
                <span>Подключение…</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="voice-stage-grid"
          style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
        >
          {roster.map((m) => (
            <ParticipantTile
              key={m.id}
              member={m}
              speaking={speakingUserIds.has(m.id)}
              muted={m.id === selfUserId ? selfMuted : m.muted}
              deafened={m.id === selfUserId ? deafened : m.deafened}
              onOpenProfile={onOpenProfile}
            />
          ))}
          {isSharingScreen && (
            <ScreenPreviewTile
              username="Вы"
              stream={ownScreenStream}
              own
              deafened={deafened}
              onWatch={() => {}}
              onExpand={() => setExpandedUserId(selfUserId)}
              onStopWatching={() => {}}
            />
          )}
          {sharingOthers.map((m) => {
            const stream = screenShares.get(m.id) ?? null
            return (
              <ScreenPreviewTile
                key={m.id}
                username={m.username}
                stream={stream}
                own={false}
                deafened={deafened}
                onWatch={() => onRequestWatch(m.id)}
                onExpand={() => {
                  if (stream) setExpandedUserId(m.id)
                }}
                onStopWatching={() => unwatchScreen(m.id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
