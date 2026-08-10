import { useCallback, useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Maximize2,
  Minimize2,
  Monitor,
  MicOff,
  HeadphoneOff,
  Volume2,
  X,
  Eye,
  Music,
  PhoneOff,
  Users,
  PictureInPicture2,
} from 'lucide-react'
import { NameEffect } from '../api'
import { styledNameProps } from '../nameStyle'
import Avatar from './Avatar'
import MicButton from './MicButton'
import ScreenShareButton from './ScreenShareButton'
import CameraButton from './CameraButton'
import SoundboardPanel from './SoundboardPanel'
import { ProfilePopupUser } from './MiniProfilePopup'
import { useSettings } from '../settings'
import { useVoice } from '../voice'
import { useLongPress } from '../hooks/useLongPress'
import { maskName, useHiddenNames } from '../hiddenNames'
import { nicknameStore, useNickname, useNicknamesVersion } from '../nicknames'

/** Document Picture-in-Picture (Chromium 116+) — в lib.dom его ещё нет.
 * Именно он, а не video.requestPictureInPicture, умеет вынести в плавающее
 * окно произвольный кусок DOM: нам нужен весь экран звонка с тулбаром. */
interface DocumentPip {
  readonly window: Window | null
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

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
  /** У аватара есть гифка — играет, пока участник говорит (см. avatarAnim.ts). */
  avatar_animated?: boolean
  muted: boolean
  deafened: boolean
  sharing_screen: boolean
  /** Стиль ника (см. nameStyle.ts) — применяется к подписи тайла участника. */
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
  name_anim_speed: number
}

/** Живой `<video>`, привязанный к MediaStream по ref — не пересоздаётся при
 * смене раскладки (grid ⇄ развёрнуто), поток не прерывается. */
function StreamVideo({
  stream,
  muted,
  onAspect,
  className,
}: {
  stream: MediaStream
  muted: boolean
  className?: string
  /** Реальное соотношение сторон потока числом (1920/1080 = 1.7778) —
   * развёрнутая демонстрация задаёт им размер своего бокса, чтобы подпись
   * легла на саму картинку, а не в чёрное поле рядом (см.
   * .voice-stage-expanded-media). */
  onAspect?: (aspect: number) => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const { outputVolume } = useSettings()
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  useEffect(() => {
    if (ref.current) ref.current.volume = outputVolume
  }, [outputVolume])
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted={muted}
      onLoadedMetadata={(e) => {
        const v = e.currentTarget
        if (onAspect && v.videoWidth > 0 && v.videoHeight > 0) {
          onAspect(v.videoWidth / v.videoHeight)
        }
      }}
    />
  )
}

function ParticipantTile({
  member,
  speaking,
  muted,
  deafened,
  onExpand,
  onContextMenu,
  allowNickname = true,
  cameraStream,
  isSelf = false,
}: {
  member: VoiceRosterMember
  speaking: boolean
  muted: boolean
  deafened: boolean
  /** Видео с камеры участника. Есть — показываем вместо аватарки: включённая
   * камера это и есть «вот он я», и держать рядом ещё и статичную аватарку
   * значило бы дважды отвечать на один вопрос. */
  cameraStream?: MediaStream | null
  /** Своя ли это плитка — от этого зависит только зеркалирование камеры
   * (см. .participant-tile-camera.self). */
  isSelf?: boolean
  /** Клик по карточке целиком — включая аватар и ник, у тех больше нет
   * своего отдельного действия (было — открыть мини-профиль) — разворачивает
   * участника на весь блок, как демонстрацию экрана — см. VoiceStage.expanded. */
  onExpand: () => void
  /** Правый клик — контекстное меню участника (см. AppShell), нет у себя самого. */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** false при «Скрыть имена» (см. namesHidden выше) — мой никнейм тоже
   * раскрывал бы личность за маскированным именем, а весь смысл маскировки
   * ровно в том, чтобы её не раскрывать. */
  allowNickname?: boolean
}) {
  // Long-press — тач-аналог правого клика выше, тот же колбэк: он читает
  // только .clientX/.clientY (см. AppShell.openParticipantContextMenu), так
  // что синтетическая точка долгого тапа годится один в один.
  const longPress = useLongPress((point) => {
    onContextMenu?.(point as unknown as ReactMouseEvent)
  })
  const nickname = useNickname(member.id)
  const displayName = (allowNickname && nickname) || member.username
  return (
    <div
      // Индикатор "говорит" — зелёная рамка ВСЕЙ карточки (а не кольцо
      // вокруг аватарки, как у Avatar в остальных местах приложения, см.
      // .avatar.speaking) — поэтому speaking сюда, а не только в <Avatar>
      // ниже (та ниже его больше не получает).
      className={`participant-tile ${speaking ? 'speaking' : ''}`}
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
      {/* Клик по аватарке — тоже БЕЗ своего onClick (раньше открывал мини-
          профиль): бывший <button> заменён на div, чтобы клик по нему
          всплывал до .participant-tile так же, как и по нику ниже — то же
          действие, что и у остальной карточки (onExpand), а не отдельное. */}
      {cameraStream ? (
        // muted: своё видео не озвучиваем (эхо), а чужая камера идёт без
        // звука вовсе — микрофон это отдельный продюсер (см. sfu.ts).
        <StreamVideo
          stream={cameraStream}
          className={`participant-tile-camera ${isSelf ? 'self' : ''}`}
          muted
        />
      ) : (
        <div className="avatar-trigger">
          <Avatar
            name={displayName}
            color={member.avatar_color}
            image={member.avatar_image}
            size={72}
            userId={member.id}
            animated={!!member.avatar_animated}
            // Гифка играет, пока человек говорит — тот же сигнал, что и
            // подсветка тайла.
            playAnimation={speaking}
          />
        </div>
      )}
      {/* Клик по нику — БЕЗ своего onClick/stopPropagation: пусть всплывает
          до .participant-tile самой карточки (onExpand выше), то же
          действие, что и клик по любому другому месту карточки. Раньше тут
          был отдельный onOpenProfile — открывал мини-профиль вместо
          разворачивания, не так, как остальная карточка. */}
      <span
        className={`participant-tile-name ${styledNameProps(member).className}`}
        style={styledNameProps(member).style}
      >
        {displayName}
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
  serverId,
  canManageSounds,
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
  /** Сервер, которому принадлежит канал, — для соундборда: звуки живут на
   * сервере. null у звонка в личке/группе, там соундборда нет. */
  serverId?: number | null
  /** Право create_expressions — можно ли заливать и удалять звуки. */
  canManageSounds?: boolean
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
    cameraStreams,
    ownCameraStream,
  } = useVoice()
  const { isHidden } = useHiddenNames()
  // Подписка на ЛЮБОЕ изменение никнеймов (см. nicknames.ts) — ниже они
  // читаются напрямую из стора (nicknameStore.get), а не через useNickname,
  // потому что читаются внутри nameOf() для переменного числа участников, а
  // не в теле компонента на верхнем уровне (хуки так вызывать нельзя).
  useNicknamesVersion()
  // «Скрыть имена» — только для голосовых каналов сервера (см.
  // ChannelContextMenu), у звонков в личке/группе такого пункта меню нет.
  const namesHidden = roomKind === 'channel' && isHidden(Number(roomId))
  const displayRoster = namesHidden
    ? roster.map((m) => ({ ...m, username: maskName(m.username) }))
    : roster

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
  // Соотношение сторон развёрнутой демонстрации — приходит из loadedmetadata
  // самого потока (см. StreamVideo.onAspect); до него честнее 16:9, чем
  // растянутый на весь контейнер бокс.
  const [demoAspect, setDemoAspect] = useState(16 / 9)
  // Свернули развёрнутый тайл — лента больше не к чему прилагается, и
  // соотношение сторон следующей демки будет своё.
  useEffect(() => {
    if (expanded == null) {
      setFilmstripOpen(false)
      setDemoAspect(16 / 9)
    }
  }, [expanded])

  // «Открыть в отдельном окне» — Document Picture-in-Picture: плавающее
  // системное окно поверх остальных, переживает уход на другую вкладку. Туда
  // переезжает ВЕСЬ .voice-stage целиком (сетка, демка, тулбар), а не только
  // <video>, как было раньше, — иначе в окне нельзя было ни выключить
  // микрофон, ни повесить трубку.
  //
  // Узел физически перемещается в документ pip-окна и возвращается обратно
  // при его закрытии; React продолжает владеть тем же самым DOM-узлом, так
  // что состояние и обработчики переживают переезд. На месте остаётся
  // распорка (placeholder), чтобы main не схлопнулся в ноль.
  const pipPlaceholderRef = useRef<HTMLDivElement>(null)
  const [inPip, setInPip] = useState(false)
  const pipSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window

  const handleTogglePip = async () => {
    const stage = containerRef.current
    const placeholder = pipPlaceholderRef.current
    if (!stage || !placeholder || !pipSupported) return
    const dpip = (window as unknown as { documentPictureInPicture: DocumentPip })
      .documentPictureInPicture
    if (dpip.window) {
      dpip.window.close()
      return
    }
    const rect = stage.getBoundingClientRect()
    let pipWindow: Window
    try {
      pipWindow = await dpip.requestWindow({
        width: Math.round(rect.width) || 960,
        height: Math.round(rect.height) || 540,
      })
    } catch {
      // Отказ пользователя или неподдерживаемый браузер — молча остаёмся на месте.
      return
    }
    // Стили в pip-окно не наследуются — переносим их копией. cssRules
    // недоступны у кросс-доменных стилей (их тут нет, но CORS-исключение
    // всё равно ловим), для них остаётся <link>.
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const css = Array.from(sheet.cssRules).map((r) => r.cssText).join('')
        const style = pipWindow.document.createElement('style')
        style.textContent = css
        pipWindow.document.head.appendChild(style)
      } catch {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link')
          link.rel = 'stylesheet'
          link.href = sheet.href
          pipWindow.document.head.appendChild(link)
        }
      }
    }
    pipWindow.document.body.style.margin = '0'
    pipWindow.document.body.style.height = '100vh'
    // Тему приложения держит data-атрибут на <html> (см. settings.tsx) —
    // без него окно откроется в дефолтной палитре.
    for (const attr of Array.from(document.documentElement.attributes)) {
      pipWindow.document.documentElement.setAttribute(attr.name, attr.value)
    }
    placeholder.style.display = 'flex'
    pipWindow.document.body.appendChild(stage)
    setInPip(true)
    pipWindow.addEventListener('pagehide', () => {
      placeholder.style.display = ''
      placeholder.parentElement?.insertBefore(stage, placeholder)
      setInPip(false)
    })
  }

  // Окно могло остаться открытым, когда VoiceStage размонтируется (вышли из
  // канала) — закрываем его, иначе узел так и висел бы в чужом документе.
  useEffect(() => {
    return () => {
      const dpip = (window as unknown as { documentPictureInPicture?: DocumentPip })
        .documentPictureInPicture
      dpip?.window?.close()
    }
  }, [])

  // Плавающая панель мут/камера/демка/сброс — как в полноэкранном
  // видеоплеере: скрыта, пока не двинуть мышью над экраном звонка, и снова
  // прячется (вместе с курсором — см. .voice-stage.controls-hidden), если
  // подержать мышь неподвижно. Мышь ушла с экрана — прячем сразу, ждать
  // таймер незачем.
  const CONTROLS_HIDE_DELAY_MS = 2500
  const [showControls, setShowControls] = useState(false)
  const [soundboardOpen, setSoundboardOpen] = useState(false)
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
        expanded.userId === selfUserId || displayRoster.some((m) => m.id === expanded.userId)
      if (!stillInRoom) setExpanded(null)
    }
  }, [expanded, isSharingScreen, availableScreenUserIds, displayRoster, selfUserId])

  // Кто демонстрирует: свой стрим — сразу по факту isSharingScreen (без
  // ожидания round-trip через presence), остальные — по presence-флагу
  // (виден даже если мы ещё не забрали их producer через SFU).
  const sharingOthers = displayRoster.filter((m) => m.id !== selfUserId && m.sharing_screen)

  const nameOf = (uid: number) => {
    const member = displayRoster.find((m) => m.id === uid)
    if (!member) return `Участник ${uid}`
    // При «Скрыть имена» никнейм тоже раскрывал бы личность за маской —
    // см. тот же приём в allowNickname у ParticipantTile.
    if (!namesHidden) {
      const nickname = nicknameStore.get(uid)
      if (nickname) return nickname
    }
    return member.username
  }

  // Сколько всего тайлов в сетке (участники + свой показ + чужие демки) —
  // от этого и от размера контейнера зависят число колонок и ширина тайлов
  // (см. computeGridLayout) — мало тайлов -> они большие и заполняют main
  // (как в Discord), много -> сетка мельче.
  const tileCount = displayRoster.length + (isSharingScreen ? 1 : 0) + sharingOthers.length
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

  const expandedMember = expanded ? displayRoster.find((m) => m.id === expanded.userId) ?? null : null
  // Стиль ника (см. nameStyle.ts) — для подписи развёрнутого тайла (см.
  // .screen-tile-label ниже), не только для мелких тайлов сетки. null —
  // участник уже вышел из комнаты (displayRoster его не находит), тогда
  // подпись просто обычным текстом, как и раньше.
  const expandedNameProps = expandedMember ? styledNameProps(expandedMember) : null

  /** Все тайлы комнаты: участники, своя демка, чужие демки. Один и тот же
   * набор рисуется и в обычной сетке, и в ленте миниатюр под развёрнутой
   * демонстрацией — размер задаётся снаружи через --tile-w, поэтому
   * компоненты переиспользуются как есть. */
  const buildTiles = () => [
    ...displayRoster.map((m) => (
      <ParticipantTile
        key={`p-${m.id}`}
        member={m}
        speaking={speakingUserIds.has(m.id)}
        muted={m.id === selfUserId ? selfMuted : m.muted}
        deafened={m.id === selfUserId ? deafened : m.deafened}
        allowNickname={!namesHidden}
        // Своя камера — из локального предпросмотра, а не из SFU: свой поток
        // обратно не приходит, да и гонять его через сервер ради себя же
        // незачем.
        cameraStream={m.id === selfUserId ? ownCameraStream : cameraStreams.get(m.id)}
        isSelf={m.id === selfUserId}
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
          username={nameOf(m.id)}
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
        <VoiceLanding
          roomName={roomName}
          roster={displayRoster}
          onJoin={onJoin}
          onOpenProfile={onOpenProfile}
        />
      </div>
    )
  }

  return (
    <>
    {/* Распорка на месте .voice-stage, пока тот уехал в pip-окно (см.
        handleTogglePip): без неё main схлопнулся бы в нулевую высоту. */}
    <div ref={pipPlaceholderRef} className="voice-stage-pip-placeholder">
      <span>Звонок открыт в отдельном окне</span>
    </div>
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
      {/* Шапка и подвал — накладки поверх содержимого, а не полосы в колонке:
          живут по тем же правилам, что и voice-controls-bar (появляются по
          движению мыши, уходят вместе с курсором), поэтому не должны отъедать
          высоту у сетки/демонстрации, пока их не видно. */}
      <header className={`voice-stage-header ${showControls ? 'visible' : ''}`}>
        {isMobile && (
          <button className="chat-back-btn" title="Назад к списку" onClick={onBack}>
            <ChevronLeft size={20} />
          </button>
        )}
        <span className="voice-stage-title">
          <Volume2 size={14} /> {roomName}
        </span>
      </header>

      {expanded != null ? (
        <div className={`voice-stage-expanded ${filmstripOpen ? 'with-filmstrip' : ''}`}>
          <div
            className="voice-stage-expanded-video"
            title="Свернуть"
            onClick={() => setExpanded(null)}
          >
            {/* Бокс ровно по соотношению сторон самого потока (до метаданных
                — 16:9), а не на всю ширину контейнера: подпись и «перестать
                смотреть» прибиты к его нижнему левому углу и потому лежат НА
                картинке, как у мини-тайлов, а не в чёрном поле рядом с ней.
                Развёрнутый УЧАСТНИК (без демки) — всегда фиксированные 16:9,
                а не demoAspect: то поле держит соотношение сторон именно
                видеопотока и не должно переживать переход в mode:'participant'
                (например, клик по чужому тайлу в открытой ленте миниатюр,
                минуя полное сворачивание, — единственный путь сменить режим,
                не потеряв expanded). */}
            <div
              className="voice-stage-expanded-media"
              style={
                { '--demo-ar': expanded.mode === 'screen' ? demoAspect : 16 / 9 } as React.CSSProperties
              }
            >
              {expanded.mode === 'screen' ? (
                expandedStream ? (
                  <StreamVideo
                    stream={expandedStream}
                    muted={expanded.userId === selfUserId || deafened}
                    onAspect={setDemoAspect}
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
                    name={nameOf(expanded.userId)}
                    color={expandedMember?.avatar_color ?? '#5865f2'}
                    image={expandedMember?.avatar_image ?? ''}
                    size={200}
                    speaking={speakingUserIds.has(expanded.userId)}
                    userId={expanded.userId}
                    animated={!!expandedMember?.avatar_animated}
                    playAnimation={speakingUserIds.has(expanded.userId)}
                  />
                </div>
              )}

              {/* stopPropagation — иначе клик по кнопке свернул бы весь тайл. */}
              <div
                className="voice-stage-expanded-overlay"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="screen-tile-label">
                  {expanded.mode === 'screen' ? (
                    <>
                      <Monitor size={13} />{' '}
                      {expanded.userId === selfUserId ? (
                        'Ваша демонстрация'
                      ) : (
                        <>
                          Демонстрация —{' '}
                          <span className={expandedNameProps?.className} style={expandedNameProps?.style}>
                            {nameOf(expanded.userId)}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className={expandedNameProps?.className} style={expandedNameProps?.style}>
                      {nameOf(expanded.userId)}
                    </span>
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
            </div>
          </div>

          {/* Лента миниатюр — те же тайлы, что и в сетке, просто мельче
              (--tile-w). Не только для демонстрации: развёрнутый участник
              (mode:'participant') тоже может подглядывать остальных — та же
              кнопка-переключатель ниже видна в обоих режимах. Рендерится
              всегда, а не только при filmstripOpen: чтобы появление можно
              было анимировать высотой, содержимое должно уже существовать в
              DOM. */}
          <div
            className="voice-stage-filmstrip"
            aria-hidden={!filmstripOpen}
            style={{ '--tile-w': `${FILMSTRIP_TILE_WIDTH}px` } as React.CSSProperties}
          >
            <div className="voice-stage-filmstrip-inner">{buildTiles()}</div>
          </div>
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

      {/* Переключатель ленты участников — ярлычок самой ленты, а не свойство
          демонстрации, поэтому ездит вместе с ней: лента закрыта — стоит над
          voice-controls-bar, открыта — переезжает на её верхнюю кромку и
          лежит поверх миниатюр (см. .voice-stage-participants-toggle.active).
          Шеврон показывает, куда лента поедет по клику. Виден при любом
          развороте — и демонстрации, и просто участника (mode:'participant'),
          не только при демке. */}
      {expanded != null && (
        <button
          className={`voice-stage-participants-toggle hover-tip ${filmstripOpen ? 'active' : ''} ${
            showControls ? 'visible' : ''
          }`}
          data-tooltip={filmstripOpen ? 'Скрыть участников' : 'Показать участников'}
          aria-label={filmstripOpen ? 'Скрыть участников' : 'Показать участников'}
          onClick={() => setFilmstripOpen((v) => !v)}
        >
          {filmstripOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          <Users size={16} />
        </button>
      )}

      {/* Все кнопки внизу — один визуальный футер: общая полоса затемнения
          (см. .voice-stage-footer в CSS, фон-градиент вместо заливки/тени у
          каждой кнопки по отдельности) плюс единая высота у всех рядов —
          основной пилюли (мут/камера/демка/сброс) и кнопок экрана
          (окно/полноэкранный), которые раньше были ниже и мельче. Сама
          полоса — чисто декоративный слой (см. .voice-stage-footer,
          pointer-events только у .visible), кнопки — отдельные абсолютно
          спозиционированные группы поверх неё, как и раньше. */}
      <footer className={`voice-stage-footer ${showControls ? 'visible' : ''}`} />

      {soundboardOpen && roomKind === 'channel' && serverId != null && (
        <SoundboardPanel
          serverId={serverId}
          canManage={!!canManageSounds}
          onClose={() => setSoundboardOpen(false)}
        />
      )}

      <div className={`voice-controls-bar ${showControls ? 'visible' : ''}`}>
        <div className="voice-controls-group">
          <MicButton />
          <CameraButton />
          <ScreenShareButton />
          {/* Соундборд — только в канале сервера: звуки принадлежат серверу,
              а у звонка в личке его нет (см. backend _readable_sound). */}
          {roomKind === 'channel' && serverId != null && (
            <button
              className={`icon-btn ${soundboardOpen ? 'active' : ''}`}
              title="Соундборд"
              onClick={() => setSoundboardOpen((v) => !v)}
            >
              <Music size={17} />
            </button>
          )}
        </div>
        <button className="voice-controls-hangup" title="Завершить звонок" onClick={onLeave}>
          <PhoneOff size={18} />
        </button>
      </div>

      <div className={`voice-stage-footer-actions ${showControls ? 'visible' : ''}`}>
        {pipSupported && (
          <button
            className="icon-btn hover-tip"
            data-tooltip={inPip ? 'Вернуть звонок во вкладку' : 'Открыть в отдельном окне'}
            aria-label={inPip ? 'Вернуть звонок во вкладку' : 'Открыть в отдельном окне'}
            onClick={handleTogglePip}
          >
            <PictureInPicture2 size={16} />
          </button>
        )}
        <button
          className="icon-btn hover-tip"
          data-tooltip={isFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
          aria-label={isFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
    </>
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
  // Подписка на изменения никнеймов — читаем их напрямую из стора ниже (см.
  // тот же приём и объяснение в VoiceStage/nameOf).
  useNicknamesVersion()
  return (
    <div className="voice-landing">
      <div className="voice-landing-icon">
        <Users size={36} />
      </div>
      <h2 className="voice-landing-title">{roomName}</h2>
      {roster.length > 0 ? (
        <div className="voice-landing-members">
          {roster.map((m) => {
            const name = nicknameStore.get(m.id) || m.username
            return (
              <button
                key={m.id}
                type="button"
                className="voice-landing-member"
                title={name}
                onClick={(e) => onOpenProfile(m, e)}
              >
                <Avatar name={name} color={m.avatar_color} image={m.avatar_image} size={40} />
              </button>
            )
          })}
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
