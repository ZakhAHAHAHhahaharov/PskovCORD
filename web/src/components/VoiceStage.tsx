import { useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import { Maximize2, Minimize2, Monitor, MicOff, HeadphoneOff, X, Eye } from 'lucide-react'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'
import { useSettings } from '../settings'
import { useVoice } from '../voice'

/** Один участник комнаты (голосовой канал сервера ИЛИ звонок в личке/группе)
 * — VoiceStage сам не знает, откуда взялся ростер (см. AppShell: для сервера
 * это members.filter(...), для диалога/группы — dmCallParticipants), только
 * рисует его. */
export interface VoiceRosterMember {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  muted: boolean
  deafened: boolean
  sharing_screen: boolean
}

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
  onExpand,
}: {
  member: VoiceRosterMember
  speaking: boolean
  muted: boolean
  deafened: boolean
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  /** Клик по карточке (не по аватару/нику — у тех своё действие, открыть
   * мини-профиль) разворачивает участника на весь блок, как демонстрацию
   * экрана — см. VoiceStage.expanded. */
  onExpand: () => void
}) {
  return (
    <div className="participant-tile" onClick={onExpand}>
      <button
        type="button"
        className="avatar-trigger"
        onClick={(e) => {
          e.stopPropagation()
          onOpenProfile(member, e)
        }}
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
        onClick={(e) => {
          e.stopPropagation()
          onOpenProfile(member, e)
        }}
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
  roomId,
  roomName,
  roster,
  selfUserId,
  pendingWatchUserId,
  onConsumedPendingWatch,
  onRequestWatch,
  onOpenProfile,
}: {
  /** Опаque id комнаты — Channel.id для сервера, Conversation.id для
   * личного/группового звонка (см. AppShell.VoiceRoom). Используется только
   * как ключ эффектов ниже, ни на что другое не влияет. */
  roomId: number | string
  roomName: string
  /** Участники комнаты — сервер сам фильтрует members по voice_channel,
   * диалог/группа собирает roster из dmCallParticipants (см. AppShell). */
  roster: VoiceRosterMember[]
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

  // mode:'screen' — развёрнута демонстрация экрана (видео/ожидание потока);
  // mode:'participant' — просто развёрнутая карточка участника без демки
  // (большой аватар вместо видео). Разные режимы по-разному авто-сворачиваются
  // (см. эффект ниже) — демку сворачиваем сами, когда стрим пропал, а
  // развёрнутую карточку участника — только когда тот вышел из канала.
  const [expanded, setExpanded] = useState<{ userId: number; mode: 'screen' | 'participant' } | null>(
    null,
  )
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
      setExpanded({ userId: selfUserId, mode: 'screen' })
      onConsumedPendingWatch()
      return
    }
    if (availableScreenUserIds.has(pendingWatchUserId)) {
      watchScreen(pendingWatchUserId)
      setExpanded({ userId: pendingWatchUserId, mode: 'screen' })
      onConsumedPendingWatch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWatchUserId, availableScreenUserIds, selfUserId])

  // Раньше `expandedUserId` просто оставался на месте, когда демонстрация,
  // которую смотрели, обрывалась (стример выключил показ) — стрим пропадал
  // из screenShares/availableScreenUserIds, а разворот оставался открытым и
  // навечно показывал плашку "Подключение…", выглядевшую как зависший
  // реконнект. Авто-сворачиваем в этом случае; развёрнутую же карточку
  // участника (без демки) сворачиваем только когда тот вышел из канала.
  useEffect(() => {
    if (!expanded) return
    if (expanded.mode === 'screen') {
      const stillSharing =
        expanded.userId === selfUserId
          ? isSharingScreen
          : availableScreenUserIds.has(expanded.userId)
      if (!stillSharing) setExpanded(null)
    } else {
      const stillInRoom =
        expanded.userId === selfUserId || roster.some((m) => m.id === expanded.userId)
      if (!stillInRoom) setExpanded(null)
    }
  }, [expanded, isSharingScreen, availableScreenUserIds, roster, selfUserId])

  // Кто демонстрирует: свой стрим — сразу по факту isSharingScreen (без
  // ожидания round-trip через presence), остальные — по presence-флагу
  // (виден даже если мы ещё не забрали их producer через SFU).
  const sharingOthers = roster.filter((m) => m.id !== selfUserId && m.sharing_screen)

  const nameOf = (uid: number) => roster.find((m) => m.id === uid)?.username ?? `Участник ${uid}`

  // Сколько всего тайлов в сетке (участники + свой показ + чужие демки) —
  // от этого зависит число колонок: мало тайлов -> они большие и заполняют
  // всё пространство main (как в Discord), много -> сетка мельче.
  const tileCount = roster.length + (isSharingScreen ? 1 : 0) + sharingOthers.length
  const gridCols = Math.max(1, Math.ceil(Math.sqrt(tileCount || 1)))

  const expandedStream =
    expanded?.mode !== 'screen'
      ? null
      : expanded.userId === selfUserId
        ? ownScreenStream
        : screenShares.get(expanded.userId) ?? null

  const expandedMember = expanded ? roster.find((m) => m.id === expanded.userId) ?? null : null

  return (
    <div ref={containerRef} className={`voice-stage ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <header className="voice-stage-header">
        <span className="voice-stage-title">
          <Monitor size={16} /> {roomName}
        </span>
        <button
          className="icon-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Свернуть из полноэкранного режима' : 'На весь экран'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </header>

      {expanded != null ? (
        <div className="voice-stage-expanded">
          <div className="voice-stage-expanded-bar">
            <span className="screen-tile-label">
              {expanded.mode === 'screen' ? (
                <>
                  <Monitor size={13} />{' '}
                  {expanded.userId === selfUserId ? 'Ваша демонстрация' : `Демонстрация — ${nameOf(expanded.userId)}`}
                </>
              ) : (
                nameOf(expanded.userId)
              )}
            </span>
            <div className="voice-stage-expanded-actions">
              {expanded.mode === 'screen' && expanded.userId !== selfUserId && (
                <button
                  className="icon-btn"
                  title="Перестать смотреть"
                  onClick={() => {
                    unwatchScreen(expanded.userId)
                    setExpanded(null)
                  }}
                >
                  <X size={16} />
                </button>
              )}
              <button className="icon-btn" title="Свернуть" onClick={() => setExpanded(null)}>
                <Minimize2 size={16} />
              </button>
            </div>
          </div>
          <div
            className="voice-stage-expanded-video"
            title="Свернуть"
            onClick={() => setExpanded(null)}
          >
            {expanded.mode === 'screen' ? (
              expandedStream ? (
                <StreamVideo stream={expandedStream} muted={expanded.userId === selfUserId || deafened} />
              ) : (
                <div className="screen-preview-placeholder">
                  <Monitor size={40} />
                  <span>Подключение…</span>
                </div>
              )
            ) : (
              <div className="participant-expanded">
                <Avatar
                  name={expandedMember?.username ?? nameOf(expanded.userId)}
                  color={expandedMember?.avatar_color ?? '#5865f2'}
                  image={expandedMember?.avatar_image ?? ''}
                  size={200}
                  speaking={speakingUserIds.has(expanded.userId)}
                />
                <span className="participant-expanded-name">{nameOf(expanded.userId)}</span>
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
              onExpand={() => setExpanded({ userId: m.id, mode: 'participant' })}
            />
          ))}
          {isSharingScreen && (
            <ScreenPreviewTile
              username="Вы"
              stream={ownScreenStream}
              own
              deafened={deafened}
              onWatch={() => {}}
              onExpand={() => setExpanded({ userId: selfUserId, mode: 'screen' })}
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
                  if (stream) setExpanded({ userId: m.id, mode: 'screen' })
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
