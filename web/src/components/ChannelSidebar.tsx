import {
  DragEvent as ReactDragEvent, Fragment, MouseEvent as ReactMouseEvent, useCallback,
  useState,
} from 'react'
import {
  ChevronDown, ChevronRight, CornerDownRight, Volume2, MicOff, HeadphoneOff, Monitor,
  Settings, Pin, Timer, Lock,
} from 'lucide-react'
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
import { nicknameStore, useNickname, useNicknamesVersion } from '../nicknames'

const COLLAPSED_KEY = 'collapsedChannelCategories'

/** Свой MIME в dataTransfer — переносим id участника голосового канала и
 * канал, откуда его тащат (перетаскивание строки на другой голосовой канал,
 * см. VoiceUserRow/voice-channel-block ниже). Собственный тип, а не
 * text/plain: раз в dataTransfer.types есть этот тип — точно наше
 * перетаскивание, а не, скажем, случайно принесённый файл или ссылка. */
const VOICE_MOVE_MIME = 'application/x-pskovcord-voice-member'

interface VoiceMoveData {
  userId: number
  fromChannelId: number
}

type ChannelKind = 'text' | 'voice'

/** «Свёрнута ли категория» — личная настройка отображения конкретного
 * сервера, как «Скрыть имена» (см. hiddenNames.ts): только localStorage,
 * никакой синхронизации с сервером. Ключ — `<serverId>:<kind>`, чтобы
 * свёрнутые голосовые на одном сервере не сворачивали их на всех. */
function loadCollapsed(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function useCollapsedCategories(serverId: number | undefined) {
  const [keys, setKeys] = useState<string[]>(loadCollapsed)

  const isCollapsed = useCallback(
    (kind: ChannelKind) => serverId != null && keys.includes(`${serverId}:${kind}`),
    [keys, serverId],
  )

  const toggle = useCallback(
    (kind: ChannelKind) => {
      if (serverId == null) return
      setKeys((prev) => {
        const key = `${serverId}:${kind}`
        const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
        try {
          localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
        } catch {
          // localStorage недоступен — просто не персистим.
        }
        return next
      })
    },
    [serverId],
  )

  return { isCollapsed, toggle }
}

/** Состав голосового канала одной строкой — аватарки внахлёст, как в
 * Discord. Показывается вместо развёрнутого списка участников, когда
 * категория «Голосовые каналы» свёрнута, а мы в этом канале сидим: канал
 * свёрнут, но с кем ты в нём — видно не разворачивая. */
function VoiceStackedAvatars({
  members: inChannel,
  speakingUserIds,
}: {
  members: Member[]
  speakingUserIds: Set<number>
}) {
  // Подписка на изменения никнеймов — читаем их напрямую из стора ниже, т.к.
  // список участников переменной длины (см. тот же приём в VoiceStage.nameOf).
  useNicknamesVersion()
  const MAX = 5
  const shown = inChannel.slice(0, MAX)
  const rest = inChannel.length - shown.length
  return (
    <span className="voice-stack">
      {shown.map((m) => {
        const name = nicknameStore.get(m.id) || m.username
        return (
          <span className="voice-stack-item" key={m.id} title={name}>
            <Avatar
              name={name}
              color={m.avatar_color}
              image={m.avatar_image}
              size={24}
              speaking={speakingUserIds.has(m.id)}
              userId={m.id}
              animated={m.avatar_animated}
              playAnimation={speakingUserIds.has(m.id)}
            />
          </span>
        )
      })}
      {rest > 0 && <span className="voice-stack-rest">+{rest}</span>}
    </span>
  )
}

/** Ветки одного канала — строками с отступом прямо под ним, как в Discord.
 *
 * Закрытые (Channel.archived) в общий список не попадают: ветку закрывают
 * именно чтобы она перестала мозолить глаза. Но и совсем прятать их нельзя —
 * иначе обсуждение исчезло бы без следа, поэтому под активными появляется
 * строка «Архив (N)», разворачивающая закрытые. Разворот локальный и
 * несохраняемый: это разовое «посмотреть, что там было», а не режим
 * отображения, который стоит помнить между заходами (в отличие от свёрнутых
 * категорий, см. useCollapsedCategories).
 */
function ChannelThreadRows({
  threads,
  activeChannelId,
  onSelect,
}: {
  threads: Channel[]
  activeChannelId: number | null
  onSelect: (c: Channel) => void
}) {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const active = threads.filter((t) => !t.archived)
  const archived = threads.filter((t) => t.archived)
  // Открытая прямо сейчас закрытая ветка (в неё вошли из плашки под
  // сообщением) показывается всегда — иначе строка, в которой ты находишься,
  // просто отсутствовала бы в сайдбаре.
  const shown = archiveOpen
    ? [...active, ...archived]
    : [...active, ...archived.filter((t) => t.id === activeChannelId)]
  if (threads.length === 0) return null
  return (
    <>
      {shown.map((t) => (
        <button
          key={t.id}
          className={`channel-item channel-thread-item ${
            activeChannelId === t.id ? 'active' : ''
          } ${t.archived ? 'channel-thread-archived' : ''}`}
          onClick={() => onSelect(t)}
          title={t.archived ? `${t.name} — ветка закрыта` : t.name}
        >
          <span className="channel-thread-branch">
            <CornerDownRight size={12} />
          </span>
          <span className="channel-name">{t.name}</span>
        </button>
      ))}
      {archived.length > 0 && (
        <button
          type="button"
          className="channel-thread-archive-toggle"
          onClick={() => setArchiveOpen((v) => !v)}
        >
          {archiveOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Архив ({archived.length})
        </button>
      )}
    </>
  )
}

function VoiceUserRow({
  member: m,
  channelId,
  speaking,
  muted,
  deafened,
  canOpenMenu,
  canDrag,
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
  /** Можно ли перетащить эту строку на другой голосовой канал — своя
   * (переключение канала, права не нужны) либо есть "manage_members" (см.
   * ChannelSidebar). */
  canDrag: boolean
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
  // При «Скрыть имена» никнейм не подставляем — та же причина, что и у
  // allowNickname в VoiceStage.ParticipantTile: он раскрывал бы личность за
  // маской.
  const nickname = useNickname(m.id)
  const displayName = (!masked && nickname) || (masked ? maskName(m.username) : m.username)
  return (
    <button
      type="button"
      className="voice-user"
      draggable={canDrag}
      onDragStart={
        canDrag
          ? (e) => {
              const data: VoiceMoveData = { userId: m.id, fromChannelId: channelId }
              e.dataTransfer.setData(VOICE_MOVE_MIME, JSON.stringify(data))
              e.dataTransfer.effectAllowed = 'move'
            }
          : undefined
      }
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
        name={displayName}
        color={m.avatar_color}
        image={m.avatar_image}
        size={20}
        speaking={speaking}
        userId={m.id}
        animated={m.avatar_animated}
        // Гифка-аватар оживает ровно на время речи — тот же сигнал, что и
        // зелёное кольцо вокруг аватарки.
        playAnimation={speaking}
      />
      <span
        className={`${speaking ? 'speaking' : ''} ${styledNameProps(m).className}`}
        style={styledNameProps(m).style}
      >
        {displayName}
      </span>
      {m.sharing_screen && (
        <span
          className="demo-badge"
          title={`Смотреть демонстрацию экрана — ${displayName}`}
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
  onMoveVoiceUser,
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
  /** Зажали ЛКМ на строке участника голосового канала и отпустили над
   * другим голосовым каналом — переместить его туда (своя строка — просто
   * переключение канала, чужая — нужно право "manage_members", проверяется
   * на сервере, см. useVoiceCall.handleMoveVoiceUser). */
  onMoveVoiceUser?: (userId: number, channel: Channel) => void
}) {
  const { speakingUserIds, muted, deafened } = useVoice()
  const { isHidden } = useHiddenNames()
  // Голосовой канал, над которым сейчас держат перетаскиваемого участника —
  // подсветка цели drop'а (см. voice-channel-block ниже).
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null)
  const { isCollapsed, toggle: toggleCategory } = useCollapsedCategories(server?.id)
  // Для себя — локальное состояние mesh'а (мгновенный отклик на клик);
  // для остальных — то, что пришло в members (видно всем, даже не
  // подключённым к этому голосовому каналу вообще).
  const micStateOf = (member: Member): { muted: boolean; deafened: boolean } =>
    member.id === user.id ? { muted, deafened } : { muted: member.muted, deafened: member.deafened }
  const textChannels = channels.filter((c) => c.kind === 'text')
  // Ветки живут не отдельной категорией, а под своим каналом (см.
  // ChannelThreadRows) — в списках каналов их поэтому нет вовсе, они
  // раскладываются по родителям.
  const threadsOf = (channelId: number) =>
    channels.filter((c) => c.kind === 'thread' && c.parent === channelId)
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

  const textCollapsed = isCollapsed('text')
  const voiceCollapsed = isCollapsed('voice')

  const voiceMembersOf = (channelId: number) =>
    members.filter((m) => m.voice_channel === String(channelId))

  // Что можно на этом сервере, решают роли (см. chat/roles.py) — владелец
  // просто получает все права разом, отдельной ветки под него нет.
  const perms = server?.my_permissions
  const canManageChannels = !!perms?.manage_channels
  // Редактор сервера открывается, если есть хоть одна доступная вкладка.
  const canEditServer =
    !!perms && (perms.manage_server || perms.manage_roles || perms.manage_members)
  // Тем же правом закрыто и «Отключить от канала» в ParticipantContextMenu —
  // перетаскивание ЧУЖОЙ строки на другой канал того же порядка серьёзности.
  const canManageMembers = !!perms?.manage_members

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
              {/* Клик по названию категории сворачивает/разворачивает её —
                  создание канала осталось за кнопкой «+» справа (раньше на
                  названии висело именно оно). */}
              <button
                className="cat-label"
                type="button"
                title={textCollapsed ? 'Развернуть' : 'Свернуть'}
                onClick={() => toggleCategory('text')}
              >
                {textCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                Текстовые каналы
              </button>
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
            {/* Свёрнутая категория всё равно показывает открытый прямо сейчас
                канал — иначе, свернув её, теряешь из виду, где находишься. */}
            {textChannels
              .filter((c) => {
                if (!textCollapsed) return true
                // Свёрнутая категория оставляет на виду не только открытый
                // канал, но и канал открытой ВЕТКИ: иначе, сидя в ветке, не
                // видно ни её, ни того, откуда она.
                if (c.id === activeChannelId) return true
                return threadsOf(c.id).some((t) => t.id === activeChannelId)
              })
              .map((c) => (
              <Fragment key={c.id}>
                <button
                  className={`channel-item ${activeChannelId === c.id ? 'active' : ''}`}
                  onClick={() => onSelectText(c)}
                  onContextMenu={
                    onChannelContextMenu
                      ? (e) => {
                          e.preventDefault()
                          onChannelContextMenu(c, e)
                        }
                      : undefined
                  }
                >
                  <span className="channel-icon">#</span>
                  <span className="channel-name">{c.name}</span>
                  {/* Медленный режим и приватность видны прямо в списке — иначе
                      о них узнаёшь только упёршись в отказ при отправке. */}
                  {c.is_private && <Lock size={12} className="channel-badge-icon" />}
                  {c.slowmode_seconds > 0 && (
                    <Timer size={12} className="channel-badge-icon" />
                  )}
                </button>
                <ChannelThreadRows
                  threads={threadsOf(c.id)}
                  activeChannelId={activeChannelId}
                  onSelect={onSelectText}
                />
              </Fragment>
            ))}

            <div className="channel-category">
              <button
                className="cat-label"
                type="button"
                title={voiceCollapsed ? 'Развернуть' : 'Свернуть'}
                onClick={() => toggleCategory('voice')}
              >
                {voiceCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                Голосовые каналы
              </button>
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
            {/* Свёрнутая категория оставляет на виду только тот канал, в
                котором мы сейчас сидим (по той же причине, что и активный
                текстовый выше) — но без списка участников: вместо него
                строка аватарок внахлёст, см. VoiceStackedAvatars. */}
            {voiceChannels
              .filter((c) => !voiceCollapsed || (voice?.room.kind === 'channel' && voice.room.id === c.id))
              .map((c) => {
              const inChannel = voiceMembersOf(c.id)
              const isMyVoiceChannel = voice?.room.kind === 'channel' && voice.room.id === c.id
              const isPinned = pinnedIds.includes(c.id)
              const masked = isHidden(c.id)
              // Перетаскивание участника на этот канал — общее для свёрнутого
              // и развёрнутого вида (drop-цель в обоих, тащить-источник —
              // только строки в развёрнутом, их в свёрнутом просто нет).
              const dropHandlers = onMoveVoiceUser
                ? {
                    onDragOver: (e: ReactDragEvent) => {
                      if (!e.dataTransfer.types.includes(VOICE_MOVE_MIME)) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    },
                    onDragEnter: (e: ReactDragEvent) => {
                      if (!e.dataTransfer.types.includes(VOICE_MOVE_MIME)) return
                      setDragOverChannelId(c.id)
                    },
                    onDragLeave: (e: ReactDragEvent) => {
                      // Уход на дочерний элемент (аватарку, иконку) — не уход
                      // с блока целиком, relatedTarget тогда всё ещё внутри.
                      if (e.currentTarget.contains(e.relatedTarget as Node)) return
                      setDragOverChannelId((prev) => (prev === c.id ? null : prev))
                    },
                    onDrop: (e: ReactDragEvent) => {
                      e.preventDefault()
                      setDragOverChannelId(null)
                      const raw = e.dataTransfer.getData(VOICE_MOVE_MIME)
                      if (!raw) return
                      try {
                        const data = JSON.parse(raw) as VoiceMoveData
                        if (data.fromChannelId === c.id) return // уже здесь
                        onMoveVoiceUser(data.userId, c)
                      } catch {
                        // Мусор в dataTransfer (не наше перетаскивание) — игнор.
                      }
                    },
                  }
                : {}
              if (voiceCollapsed) {
                return (
                  <div
                    key={c.id}
                    className={`voice-channel-block ${dragOverChannelId === c.id ? 'drop-target' : ''}`}
                    {...dropHandlers}
                  >
                    <button
                      className="channel-item active"
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
                      <span className="channel-icon in-voice">
                        <Volume2 size={15} />
                      </span>
                      <VoiceStackedAvatars members={inChannel} speakingUserIds={speakingUserIds} />
                    </button>
                  </div>
                )
              }
              return (
                <div
                  key={c.id}
                  className={`voice-channel-block ${dragOverChannelId === c.id ? 'drop-target' : ''}`}
                  {...dropHandlers}
                >
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
                    // Своя строка тащится всегда (это просто переключение
                    // канала, права не нужны — см. handleMoveVoiceUser);
                    // чужая — только если можно ею управлять.
                    const canDrag =
                      !!onMoveVoiceUser && (m.id === user.id || canManageMembers)
                    return (
                      <VoiceUserRow
                        key={m.id}
                        member={m}
                        channelId={c.id}
                        speaking={speaking}
                        muted={mic.muted}
                        deafened={mic.deafened}
                        canOpenMenu={canOpenMenu}
                        canDrag={canDrag}
                        masked={masked}
                        onOpenParticipantProfile={onOpenParticipantProfile}
                        onParticipantContextMenu={onParticipantContextMenu}
                        onWatchScreen={onWatchScreen}
                      />
                    )
                  })}
                  {/* У голосового канала есть свой текстовый чат (см.
                      AppShellChat), а значит бывают и ветки из его сообщений —
                      показываются так же, как у текстового канала. */}
                  <ChannelThreadRows
                    threads={threadsOf(c.id)}
                    activeChannelId={activeChannelId}
                    onSelect={onSelectText}
                  />
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
