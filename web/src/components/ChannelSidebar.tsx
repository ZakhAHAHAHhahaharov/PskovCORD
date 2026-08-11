import {
  DragEvent as ReactDragEvent, Fragment, MouseEvent as ReactMouseEvent, useCallback,
  useState,
} from 'react'
import {
  ChevronDown, ChevronRight, CornerDownRight, Volume2, MicOff, HeadphoneOff, Monitor,
  Settings, Pin, Timer, Lock,
} from 'lucide-react'
import { Channel, ChannelCategory, Member, Server, User } from '../api'
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

/** Тот же приём для перетаскивания САМОГО канала между разделами. Свой MIME,
 * а не общий с VOICE_MOVE_MIME: у голосового канала drop-цель есть и на нём
 * самом (перенос участника), и без разделения типов он ловил бы чужое
 * перетаскивание. */
const CHANNEL_MOVE_MIME = 'application/x-pskovcord-channel'

interface VoiceMoveData {
  userId: number
  fromChannelId: number
}

type ChannelKind = 'text' | 'voice'

/** Ключ группы в сайдбаре: `cat:<id>` — раздел, заведённый на сервере,
 * `none:text`/`none:voice` — каналы вне разделов. Строкой, а не парой полей:
 * он же уезжает в localStorage (см. useCollapsedCategories). */
type GroupKey = string

/** «Свёрнута ли группа» — личная настройка отображения конкретного
 * сервера, как «Скрыть имена» (см. hiddenNames.ts): только localStorage,
 * никакой синхронизации с сервером. Ключ — `<serverId>:<группа>`, чтобы
 * свёрнутое на одном сервере не сворачивалось на всех. */
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
    (group: GroupKey) => serverId != null && keys.includes(`${serverId}:${group}`),
    [keys, serverId],
  )

  const toggle = useCallback(
    (group: GroupKey) => {
      if (serverId == null) return
      setKeys((prev) => {
        const key = `${serverId}:${group}`
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
  openThreadId,
  onSelect,
}: {
  threads: Channel[]
  /** Ветка, открытая в панели справа (см. ThreadPanel) — она и подсвечена.
   * Не activeChannelId: ветка не подменяет канал, она открывается РЯДОМ с
   * ним, и подсвеченными оказываются оба — и канал, и его ветка. */
  openThreadId: number | null
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
    : [...active, ...archived.filter((t) => t.id === openThreadId)]
  if (threads.length === 0) return null
  return (
    <>
      {shown.map((t) => (
        <button
          key={t.id}
          className={`channel-item channel-thread-item ${
            openThreadId === t.id ? 'active' : ''
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
  openThreadId,
  onOpenThread,
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
  categories,
  onMoveChannelToCategory,
  onCategoryContextMenu,
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
  /** Ветка, открытая в панели справа — подсвечена в списке отдельно от
   * активного канала (см. ChannelThreadRows). */
  openThreadId: number | null
  /** Клик по строке ветки — открыть её панелью рядом с родительским каналом
   * (см. useServerData.handleOpenThread), а не «перейти» в неё. */
  onOpenThread: (c: Channel) => void
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
  /** categoryId — в какой раздел создавать; null — вне разделов. */
  onCreateChannel: (kind: 'text' | 'voice', categoryId: number | null) => void
  /** Разделы сервера в их порядке (см. backend ChannelCategory). */
  categories: ChannelCategory[]
  /** Перенос канала в раздел перетаскиванием. null — вынести из разделов. */
  onMoveChannelToCategory?: (channelId: number, categoryId: number | null) => void
  /** Правый клик по названию раздела — переименовать/удалить. Не приходит
   * для групп «вне разделов»: там переименовывать нечего. */
  onCategoryContextMenu?: (
    categoryId: number,
    name: string,
    e: ReactMouseEvent,
  ) => void
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
  // Заголовок группы, над которым сейчас держат перетаскиваемый канал.
  const [dragOverCategory, setDragOverCategory] = useState<GroupKey | null>(null)
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
  //
  // И только СВОИ: в сайдбаре висят ветки, к которым ты присоединился (сам
  // или написав в них), как в Discord. Остальные достаются из «Показать все
  // ветки» — иначе канал с десятком обсуждений превращал бы сайдбар в стену,
  // где своё не найти. Исключение — открытая прямо сейчас: пока смотришь
  // ветку, её строка должна быть на месте, даже если ты в ней не участвуешь.
  const threadsOf = (channelId: number) =>
    channels.filter(
      (c) => c.kind === 'thread'
        && c.parent === channelId
        && (c.joined || c.id === openThreadId),
    )
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

  /** Группы сайдбара сверху вниз: сначала каналы вне разделов, потом сами
   * разделы в своём порядке — как в Discord.
   *
   * Вне разделов текст и голос по-прежнему разнесены на две группы: пока
   * разделов не завели вовсе, сайдбар обязан выглядеть ровно как раньше, а
   * не свалить всё в одну кучу. Внутри РАЗДЕЛА они идут подряд — там
   * разделять уже нечего, на то раздел и заводили. */
  const groups: {
    key: GroupKey
    title: string
    channels: Channel[]
    /** Какой вид канала создаёт кнопка «+» этой группы. У раздела — текстовый
     * (самый частый), у групп «вне разделов» — их собственный вид. */
    createKind: ChannelKind
    categoryId: number | null
  }[] = []

  const uncategorizedText = textChannels.filter((c) => c.category == null)
  const uncategorizedVoice = voiceChannels.filter((c) => c.category == null)
  if (uncategorizedText.length > 0 || categories.length === 0) {
    groups.push({
      key: 'none:text', title: 'Текстовые каналы',
      channels: uncategorizedText, createKind: 'text', categoryId: null,
    })
  }
  if (uncategorizedVoice.length > 0 || categories.length === 0) {
    groups.push({
      key: 'none:voice', title: 'Голосовые каналы',
      channels: uncategorizedVoice, createKind: 'voice', categoryId: null,
    })
  }
  for (const category of categories) {
    groups.push({
      key: `cat:${category.id}`,
      title: category.name,
      // Текст выше голоса — тот же порядок, что и вне разделов, чтобы взгляд
      // не переучивался при переходе от группы к группе.
      channels: [
        ...textChannels.filter((c) => c.category === category.id),
        ...voiceChannels.filter((c) => c.category === category.id),
      ],
      createKind: 'text',
      categoryId: category.id,
    })
  }

  /** Строка текстового канала вместе с его ветками. */
  const renderTextChannel = (c: Channel) => (
    <Fragment key={c.id}>
      <button
        className={`channel-item ${activeChannelId === c.id ? 'active' : ''}`}
        onClick={() => onSelectText(c)}
        draggable={canManageChannels}
        onDragStart={(e) => {
          if (!canManageChannels) return
          e.dataTransfer.setData(CHANNEL_MOVE_MIME, String(c.id))
          e.dataTransfer.effectAllowed = 'move'
        }}
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
        openThreadId={openThreadId}
        onSelect={onOpenThread}
      />
    </Fragment>
  )

  /** Блок голосового канала: строка, участники, ветки и цель перетаскивания.
   * collapsed — свёрнутый вид (только аватарки внахлёст, без списка). */
  const renderVoiceChannel = (c: Channel, collapsed: boolean) => {
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
    if (collapsed) {
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
          className={`channel-item ${voice?.room.id === c.id ? 'active' : ''}`}
          onClick={() => onJoinVoice(c)}
          draggable={canManageChannels}
          onDragStart={(e) => {
            if (!canManageChannels) return
            e.dataTransfer.setData(CHANNEL_MOVE_MIME, String(c.id))
            e.dataTransfer.effectAllowed = 'move'
          }}
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
          const canDrag = !!onMoveVoiceUser && (m.id === user.id || canManageMembers)
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
          openThreadId={openThreadId}
          onSelect={onOpenThread}
        />
      </div>
    )
  }

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
            {groups.map((group) => {
              const collapsed = isCollapsed(group.key)
              // Пустой раздел виден только тем, кто может завести в нём
              // канал: остальным это просто заголовок, за которым ничего
              // нет (все каналы внутри могут быть приватными и невидимыми).
              if (group.channels.length === 0 && !canManageChannels) return null
              return (
                <Fragment key={group.key}>
                  <div
                    className={`channel-category ${
                      dragOverCategory === group.key ? 'drop-target' : ''
                    }`}
                    // Перетаскивание САМОГО КАНАЛА на заголовок — перенос его
                    // в этот раздел. Цель именно заголовок, а не вся группа:
                    // внутри группы уже есть свои drop-цели у голосовых
                    // каналов (перенос участника), и две вложенных цели с
                    // разным смыслом ловили бы чужие события.
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(CHANNEL_MOVE_MIME)) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDragEnter={(e) => {
                      if (!e.dataTransfer.types.includes(CHANNEL_MOVE_MIME)) return
                      setDragOverCategory(group.key)
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget.contains(e.relatedTarget as Node)) return
                      setDragOverCategory((prev) => (prev === group.key ? null : prev))
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDragOverCategory(null)
                      const raw = e.dataTransfer.getData(CHANNEL_MOVE_MIME)
                      if (!raw || !onMoveChannelToCategory) return
                      const channelId = Number(raw)
                      if (Number.isNaN(channelId)) return
                      onMoveChannelToCategory(channelId, group.categoryId)
                    }}
                  >
                    {/* Клик по названию сворачивает/разворачивает группу —
                        создание канала осталось за кнопкой «+» справа. */}
                    <button
                      className="cat-label"
                      type="button"
                      title={collapsed ? 'Развернуть' : 'Свернуть'}
                      onClick={() => toggleCategory(group.key)}
                      onContextMenu={
                        group.categoryId != null && onCategoryContextMenu
                          ? (e) => {
                              e.preventDefault()
                              onCategoryContextMenu(group.categoryId!, group.title, e)
                            }
                          : undefined
                      }
                    >
                      {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      {group.title}
                    </button>
                    {canManageChannels && (
                      <button
                        className="cat-add"
                        title={
                          group.createKind === 'voice'
                            ? 'Создать голосовой канал'
                            : 'Создать текстовый канал'
                        }
                        onClick={() => onCreateChannel(group.createKind, group.categoryId)}
                      >
                        +
                      </button>
                    )}
                  </div>
                  {group.channels
                    .filter((c) => {
                      if (!collapsed) return true
                      // Свёрнутая группа всё равно показывает то, где мы
                      // сейчас находимся — иначе, свернув её, теряешь из
                      // виду своё место: открытый канал, канал открытой
                      // ветки и голосовой, в котором сидим.
                      if (c.id === activeChannelId) return true
                      if (voice?.room.kind === 'channel' && voice.room.id === c.id) return true
                      return threadsOf(c.id).some((t) => t.id === openThreadId)
                    })
                    .map((c) =>
                      c.kind === 'voice'
                        ? renderVoiceChannel(c, collapsed)
                        : renderTextChannel(c),
                    )}
                </Fragment>
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
