import { useCallback, useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronLeft,
  Maximize2,
  Minimize2,
  Monitor,
  MicOff,
  HeadphoneOff,
  X,
  Eye,
  Video,
  PhoneOff,
  Users,
  PictureInPicture2,
} from 'lucide-react'
import Avatar from './Avatar'
import MicButton from './MicButton'
import ScreenShareButton from './ScreenShareButton'
import { ProfilePopupUser } from './MiniProfilePopup'
import { useSettings } from '../settings'
import { useVoice } from '../voice'
import { useLongPress } from '../hooks/useLongPress'

/** Зазор между тайлами сетки — используется и в CSS (.voice-stage-grid gap),
 * и здесь при расчёте ширины тайла, оба места обязаны совпадать. */
const GRID_GAP = 8
/** Тайлы не мельче и не крупнее этого — совсем маленькими нечитаемо, совсем
 * большими на широком мониторе один собеседник смотрелся бы нелепо. */
const MIN_TILE_WIDTH = 220
const MAX_TILE_WIDTH = 560

/** Ширина миниатюры в ленте под развёрнутой демонстрацией; высота из неё же
 * по 16:9 — с ней должна совпадать высота .voice-stage-filmstrip в CSS. */
const FILMSTRIP_TILE_WIDTH = 160

/**
 * Сколько колонок и какой ширины должен быть каждый 16:9-тайл, чтобы:
 *  - при малом числе тайлов раскладка была "квадратной" (1 — по центру,
 *    2 — делят ширину пополам, 3 — двое сверху и один по центру снизу и т.д.
 *    — обычная ceil(sqrt(n)) раскладка, как в Discord/Zoom);
 *  - на узком контейнере колонок было меньше, чем требует квадратная
 *    раскладка, — иначе тайлы просто мельчают до нечитаемости вместо того,
 *    чтобы перенестись на новую строку;
 *  - высота 16:9-тайла не вылезала за пределы доступной высоты (актуально
 *    для одного собеседника на невысоком окне).
 * Центрирование неполной последней строки — уже не здесь, а в CSS
 * (display:flex; flex-wrap; justify-content:center — см. .voice-stage-grid).
 */
function computeGridLayout(
  count: number,
  containerWidth: number,
  containerHeight: number,
): { cols: number; tileWidth: number } {
  if (count <= 0) return { cols: 1, tileWidth: MIN_TILE_WIDTH }
  const idealCols = Math.ceil(Math.sqrt(count))
  const maxColsByWidth =
    containerWidth > 0
      ? Math.max(1, Math.floor((containerWidth + GRID_GAP) / (MIN_TILE_WIDTH + GRID_GAP)))
      : idealCols
  const cols = Math.min(idealCols, maxColsByWidth, count)
  let tileWidth =
    containerWidth > 0 ? (containerWidth - GRID_GAP * (cols - 1)) / cols : MAX_TILE_WIDTH
  if (containerHeight > 0) {
    const rows = Math.ceil(count / cols)
    const maxTileHeight = (containerHeight - GRID_GAP * (rows - 1)) / rows
    tileWidth = Math.min(tileWidth, maxTileHeight * (16 / 9))
  }
  tileWidth = Math.min(Math.max(tileWidth, MIN_TILE_WIDTH), MAX_TILE_WIDTH)
  return { cols, tileWidth }
}

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
function StreamVideo({
  stream,
  muted,
  videoRef,
}: {
  stream: MediaStream
  muted: boolean
  /** Наружу — только чтобы развёрнутая демонстрация могла отдать этот самый
   * элемент в Picture-in-Picture (см. handleTogglePip). Внутренняя привязка
   * потока продолжает работать через тот же ref. */
  videoRef?: React.RefObject<HTMLVideoElement>
}) {
  const localRef = useRef<HTMLVideoElement>(null)
  const ref = videoRef ?? localRef
  const { outputVolume } = useSettings()
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [ref, stream])
  useEffect(() => {
    if (ref.current) ref.current.volume = outputVolume
  }, [ref, outputVolume])
  return <video ref={ref} autoPlay playsInline muted={muted} />
}

function ParticipantTile({
  member,
  speaking,
  muted,
  deafened,
  onOpenProfile,
  onExpand,
  onContextMenu,
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
  /** Правый клик — контекстное меню участника (см. AppShell), нет у себя самого. */
  onContextMenu?: (e: ReactMouseEvent) => void
}) {
  // Long-press — тач-аналог правого клика выше, тот же колбэк: он читает
  // только .clientX/.clientY (см. AppShell.openParticipantContextMenu), так
  // что синтетическая точка долгого тапа годится один в один.
  const longPress = useLongPress((point) => {
    onContextMenu?.(point as unknown as ReactMouseEvent)
  })
  return (
    <div
      className="participant-tile"
      // avatar_color — теперь средний цвет самой аватарки (см. backend
      // accounts.avatar_color.compute_avatar_color), а не просто фон буквы-
      // заглушки, поэтому используем его и как акцент фона тайла — см.
      // .participant-tile в index.css (color-mix c --tile-accent).
      style={{ '--tile-accent': member.avatar_color } as React.CSSProperties}
      onClick={onExpand}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              onContextMenu(e)
            }
          : undefined
      }
      {...(onContextMenu ? longPress : {})}
    >
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
          size={72}
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
        {muted && (
          <span title="Микрофон выключен">
            <MicOff size={12} />
          </span>
        )}
        {deafened && (
          <span title="Не слышит участников">
            <HeadphoneOff size={12} />
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
    // Поток уже смотрим — клик разворачивает; ещё нет — начинает просмотр
    // (в ленте миниатюр под развёрнутой демкой кнопка «Смотреть демку» не
    // помещается и скрыта, так что клик по тайлу — единственный способ).
    <div className="screen-preview-tile" onClick={stream ? onExpand : onWatch}>
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
  onParticipantContextMenu,
  roomKind,
  isConnected,
  onJoin,
  onLeave,
  isMobile,
  onBack,
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
  /** Правый клик на участнике — контекстное меню (см. AppShell). Открывается
   * и для сервера, и для звонка в личке/группе — какие пункты внутри
   * доступны (голосование/демо — только сервер и полное подключение),
   * решает сам AppShell по roomKind/voiceStatus. */
  onParticipantContextMenu?: (
    member: VoiceRosterMember,
    e: ReactMouseEvent,
    room: { kind: 'channel' | 'conversation'; id: number | string },
  ) => void
  /** Канал сервера или звонок в личке/группе — прокидывается в
   * onParticipantContextMenu вместе с roomId, чтобы AppShell знал, какую
   * комнату показывает это конкретное меню. */
  roomKind: 'channel' | 'conversation'
  /** Подключены ли мы САМИ к этой конкретной комнате прямо сейчас (сравнение
   * с VoiceMesh делает AppShell — VoiceStage сам не знает глобальный voice-
   * стейт). false — канал просто выбран/открыт, но мы не в звонке: вместо
   * сетки участников показываем VoiceLanding с кнопкой "Присоединиться". */
  isConnected: boolean
  onJoin: () => void
  onLeave: () => void
  /** Мобильный layout — только для этого рендерится кнопка "назад" ниже
   * (см. AppShell.isMobile/goBackMobile); сам VoiceStage не знает ширину
   * вьюпорта. */
  isMobile?: boolean
  onBack?: () => void
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

  // Размер .voice-stage-grid — от него зависит, сколько колонок и какой
  // ширины тайлы (см. computeGridLayout). Меряем именно этот элемент, а не
  // .voice-stage целиком — у него ещё есть header, а paddings/gap уже внутри
  // самого grid-контейнера.
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setGridSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded == null])

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

  // Лента миниатюр под развёрнутой демонстрацией (все участники + все другие
  // демки) — по умолчанию скрыта, разворачивается кнопкой «Участники»,
  // сама демка при этом ужимается по высоте (см. .with-filmstrip в CSS).
  const [filmstripOpen, setFilmstripOpen] = useState(false)
  // Свернули развёрнутый тайл — лента больше не к чему прилагается.
  useEffect(() => {
    if (expanded == null) setFilmstripOpen(false)
  }, [expanded])

  // Picture-in-Picture — это и есть «отдельное окно» для видео: плавающее
  // системное окно поверх остальных, переживает уход на другую вкладку.
  // Собственный popup тут не годится — MediaStream в другое окно так просто
  // не передать.
  const pipVideoRef = useRef<HTMLVideoElement>(null)
  const pipSupported =
    typeof document !== 'undefined' && document.pictureInPictureEnabled === true
  const handleTogglePip = () => {
    const video = pipVideoRef.current
    if (!video) return
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {})
    } else {
      void video.requestPictureInPicture().catch(() => {})
    }
  }

  // Плавающая панель мут/камера/демка/сброс — как в полноэкранном
  // видеоплеере: скрыта, пока не двинуть мышью над экраном звонка, и снова
  // прячется (вместе с курсором — см. .voice-stage.controls-hidden), если
  // подержать мышь неподвижно. Мышь ушла с экрана — прячем сразу, ждать
  // таймер незачем.
  const CONTROLS_HIDE_DELAY_MS = 2500
  const [showControls, setShowControls] = useState(false)
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    hideControlsTimer.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
  }, [])

  const handleStageMouseMove = useCallback(() => {
    if (!isConnected) return
    setShowControls(true)
    scheduleHideControls()
  }, [isConnected, scheduleHideControls])

  const handleStageMouseLeave = useCallback(() => {
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    setShowControls(false)
  }, [])

  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    }
  }, [])

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
  // от этого и от размера контейнера зависят число колонок и ширина тайлов
  // (см. computeGridLayout) — мало тайлов -> они большие и заполняют main
  // (как в Discord), много -> сетка мельче.
  const tileCount = roster.length + (isSharingScreen ? 1 : 0) + sharingOthers.length
  const { cols: gridCols, tileWidth } = computeGridLayout(
    tileCount,
    gridSize.width,
    gridSize.height,
  )

  const expandedStream =
    expanded?.mode !== 'screen'
      ? null
      : expanded.userId === selfUserId
        ? ownScreenStream
        : screenShares.get(expanded.userId) ?? null

  const expandedMember = expanded ? roster.find((m) => m.id === expanded.userId) ?? null : null

  /** Все тайлы комнаты: участники, своя демка, чужие демки. Один и тот же
   * набор рисуется и в обычной сетке, и в ленте миниатюр под развёрнутой
   * демонстрацией — размер задаётся снаружи через --tile-w, поэтому
   * компоненты переиспользуются как есть. */
  const buildTiles = () => [
    ...roster.map((m) => (
      <ParticipantTile
        key={`p-${m.id}`}
        member={m}
        speaking={speakingUserIds.has(m.id)}
        muted={m.id === selfUserId ? selfMuted : m.muted}
        deafened={m.id === selfUserId ? deafened : m.deafened}
        onOpenProfile={onOpenProfile}
        onExpand={() => setExpanded({ userId: m.id, mode: 'participant' })}
        onContextMenu={
          m.id !== selfUserId && onParticipantContextMenu
            ? (e) => onParticipantContextMenu(m, e, { kind: roomKind, id: roomId })
            : undefined
        }
      />
    )),
    ...(isSharingScreen
      ? [
          <ScreenPreviewTile
            key="s-own"
            username="Вы"
            stream={ownScreenStream}
            own
            deafened={deafened}
            onWatch={() => {}}
            onExpand={() => setExpanded({ userId: selfUserId, mode: 'screen' })}
            onStopWatching={() => {}}
          />,
        ]
      : []),
    ...sharingOthers.map((m) => {
      const stream = screenShares.get(m.id) ?? null
      return (
        <ScreenPreviewTile
          key={`s-${m.id}`}
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
    }),
  ]

  if (!isConnected) {
    return (
      <div className="voice-stage voice-stage-landing">
        {isMobile && (
          <button className="chat-back-btn voice-stage-back-btn" title="Назад к списку" onClick={onBack}>
            <ChevronLeft size={20} />
          </button>
        )}
        <VoiceLanding roomName={roomName} roster={roster} onJoin={onJoin} onOpenProfile={onOpenProfile} />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`voice-stage ${isFullscreen ? 'is-fullscreen' : ''} ${!showControls ? 'controls-hidden' : ''}`}
      onMouseMove={handleStageMouseMove}
      onMouseLeave={handleStageMouseLeave}
      // Тулбар управления (мик/камера/демка/повесить трубку) на десктопе
      // прячется без движения мыши (см. handleStageMouseMove/scheduleHideControls
      // выше) — на тач-устройстве mousemove никогда не приходит от тапа, и
      // без этого клик тулбар был бы недостижим. Клик работает и мышью
      // (просто лишний повод показать тулбар), отдельной ветки под isMobile
      // не нужно.
      onClick={handleStageMouseMove}
    >
      <header className="voice-stage-header">
        {isMobile && (
          <button className="chat-back-btn" title="Назад к списку" onClick={onBack}>
            <ChevronLeft size={20} />
          </button>
        )}
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
        <div className={`voice-stage-expanded ${filmstripOpen ? 'with-filmstrip' : ''}`}>
          <div
            className="voice-stage-expanded-video"
            title="Свернуть"
            onClick={() => setExpanded(null)}
          >
            {expanded.mode === 'screen' ? (
              expandedStream ? (
                <StreamVideo
                  stream={expandedStream}
                  muted={expanded.userId === selfUserId || deafened}
                  videoRef={pipVideoRef}
                />
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
              </div>
            )}

            {/* Подпись и «перестать смотреть» — в левом нижнем углу, поверх
                видео (как и у тайлов в сетке); отдельной «шапки» сверху нет.
                Открыть-в-окне/полноэкран уехали в правый нижний угол, а
                «Показать участников» — наверх, над voice-controls-bar (см.
                .voice-stage-participants-toggle ниже). stopPropagation —
                иначе клик по кнопке свернул бы весь тайл. */}
            <div
              className="voice-stage-expanded-overlay"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="screen-tile-label">
                {expanded.mode === 'screen' ? (
                  <>
                    <Monitor size={13} />{' '}
                    {expanded.userId === selfUserId
                      ? 'Ваша демонстрация'
                      : `Демонстрация — ${nameOf(expanded.userId)}`}
                  </>
                ) : (
                  nameOf(expanded.userId)
                )}
              </span>
              {expanded.mode === 'screen' && expanded.userId !== selfUserId && (
                <div className="voice-stage-expanded-actions">
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
                </div>
              )}
            </div>

            {/* Открыть в отдельном окне / на весь экран — в правом нижнем
                углу демонстрации (не зависят от того, звонок это или
                участник — полноэкранный режим есть у обоих). */}
            <div
              className="voice-stage-expanded-corner"
              onClick={(e) => e.stopPropagation()}
            >
              {expanded.mode === 'screen' && pipSupported && expandedStream && (
                <button
                  className="icon-btn"
                  title="Открыть в отдельном окне"
                  onClick={handleTogglePip}
                >
                  <PictureInPicture2 size={16} />
                </button>
              )}
              <button
                className="icon-btn"
                title={isFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
                onClick={toggleFullscreen}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </div>
          </div>

          {/* Лента миниатюр под демонстрацией — те же тайлы, что и в сетке,
              просто мельче (--tile-w). Рендерится всегда, а не только при
              filmstripOpen: чтобы её появление можно было анимировать
              высотой, содержимое должно уже существовать в DOM. */}
          {expanded.mode === 'screen' && (
            <div
              className="voice-stage-filmstrip"
              aria-hidden={!filmstripOpen}
              style={{ '--tile-w': `${FILMSTRIP_TILE_WIDTH}px` } as React.CSSProperties}
            >
              <div className="voice-stage-filmstrip-inner">{buildTiles()}</div>
            </div>
          )}
        </div>
      ) : (
        (() => {
          // Тайлы разбиваем на строки ровно по gridCols. Строка — отдельный
          // flex-контейнер с justify-content: center, поэтому неполная
          // последняя строка (например, третий тайл из трёх) центрируется
          // сама, без ручной раскладки по колонкам.
          const tiles = buildTiles()
          const rows: (typeof tiles)[] = []
          for (let i = 0; i < tiles.length; i += gridCols) rows.push(tiles.slice(i, i + gridCols))
          const rowStyle = { '--tile-w': `${tileWidth}px` } as React.CSSProperties
          return (
            <div ref={gridRef} className="voice-stage-grid">
              {rows.map((row, i) => (
                <div key={i} className="voice-stage-row" style={rowStyle}>
                  {row}
                </div>
              ))}
            </div>
          )
        })()
      )}

      {/* Наверху, над панелью отключения/прекращения демонстрации — а не в
          углу самой демки: это переключатель ленты участников, а не свойство
          видео (в отличие от открыть-в-окне/полноэкран рядом с ним). */}
      {expanded?.mode === 'screen' && (
        <button
          className={`voice-stage-participants-toggle ${filmstripOpen ? 'active' : ''} ${
            showControls ? 'visible' : ''
          }`}
          title={filmstripOpen ? 'Скрыть участников' : 'Показать участников'}
          onClick={() => setFilmstripOpen((v) => !v)}
        >
          <Users size={16} />
        </button>
      )}

      <div className={`voice-controls-bar ${showControls ? 'visible' : ''}`}>
        <div className="voice-controls-group">
          <MicButton />
          <button
            className="icon-btn"
            title="Включить камеру"
            onClick={() => window.alert('Видеокамера скоро появится здесь — пока не реализована.')}
          >
            <Video size={17} />
          </button>
          <ScreenShareButton />
        </div>
        <button className="voice-controls-hangup" title="Завершить звонок" onClick={onLeave}>
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  )
}

/** Голосовой канал выбран, но мы сами в него не зашли — вместо сетки
 * участников большой "экран приглашения" (градиентный фон, название канала,
 * кто уже внутри) с кнопкой входа. Тот же паттерн, что у Discord: канал
 * можно разглядывать, не подключаясь. */
function VoiceLanding({
  roomName,
  roster,
  onJoin,
  onOpenProfile,
}: {
  roomName: string
  roster: VoiceRosterMember[]
  onJoin: () => void
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  return (
    <div className="voice-landing">
      <div className="voice-landing-icon">
        <Users size={36} />
      </div>
      <h2 className="voice-landing-title">{roomName}</h2>
      {roster.length > 0 ? (
        <div className="voice-landing-members">
          {roster.map((m) => (
            <button
              key={m.id}
              type="button"
              className="voice-landing-member"
              title={m.username}
              onClick={(e) => onOpenProfile(m, e)}
            >
              <Avatar name={m.username} color={m.avatar_color} image={m.avatar_image} size={40} />
            </button>
          ))}
        </div>
      ) : (
        <p className="voice-landing-empty">Сейчас в голосовом канале никого нет</p>
      )}
      <button className="voice-landing-join" onClick={onJoin}>
        Присоединиться к голосовому каналу
      </button>
    </div>
  )
}
