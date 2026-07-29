import { useCallback, useEffect, useMemo, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import { ChevronLeft, Phone, PhoneOff, Users } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import {
  api, Channel, ChatMessageBase, Conversation, ConversationMessage, FriendsState, KnownPerson,
  Member, Message, NotificationLevel, Role, Server, ServerMemberSettings,
} from '../api'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import { isMentioned } from '../mentions'
import {
  outbox, pendingAsMessage, usePendingMessages, OutboxTarget,
} from '../outbox'
import {
  playJoinSound,
  playLeaveSound,
  playScreenShareRequestSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
} from '../sounds'
import ServerRail from './ServerRail'
import ChannelSidebar from './ChannelSidebar'
import HomeSidebar from './HomeSidebar'
import NewConversationModal from './NewConversationModal'
import IncomingCallBanner from './IncomingCallBanner'
import MessageList from './MessageList'
import MessageInput, { MessageInputPrefill, OutgoingMessage } from './MessageInput'
import MembersList from './MembersList'
import VoiceProvider, { VoiceStatus } from './VoiceProvider'
import VoiceStage, { VoiceRosterMember } from './VoiceStage'
import DiscoverModal from './DiscoverModal'
import ServerSettingsModal from './ServerSettingsModal'
import SettingsModal from './SettingsModal'
import ProfileModal from './ProfileModal'
import MiniProfilePopup, { ProfilePopupTarget, ProfilePopupUser } from './MiniProfilePopup'
import ParticipantContextMenu, {
  ParticipantContextMenuMember,
  ParticipantContextMenuTarget,
} from './ParticipantContextMenu'
import MuteVoteModal from './MuteVoteModal'
import ServerContextMenu from './ServerContextMenu'
import ServerPrivacyModal from './ServerPrivacyModal'
import ServerInviteModal from './ServerInviteModal'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

function conversationDisplayName(c: Conversation): string {
  if (c.kind === 'group') {
    return c.name || c.participants.map((p) => p.username).join(', ') || 'Группа'
  }
  return c.participants[0]?.username ?? 'Личное сообщение'
}

/** Комната активного звонка — голосовой канал сервера ИЛИ диалог/группа.
 * voice.ts/VoiceProvider работают только с `.id` (ключ WebRTC-mesh эффектов)
 * и не знают о разнице; `.kind` нужен только здесь, в AppShell, чтобы понять,
 * какой стейт (серверный `members` или dm-ростер) отражает участников. */
export interface VoiceRoom {
  id: number | string
  name: string
  kind: 'channel' | 'conversation'
}

export interface VoiceState {
  room: VoiceRoom
  /** WS-адрес сигналинга SFU и токен доступа (из voice-credentials). */
  sfuUrl: string
  sfuToken: string
}

interface CallParticipant {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  muted: boolean
  deafened: boolean
  sharing_screen: boolean
}

interface IncomingCall {
  conversationId: number
  caller: CallParticipant
}

export default function AppShell() {
  const { user, logout } = useAuth()
  const gateway = useGateway()

  // --- мобильный layout: список каналов (nav) vs открытый канал (content),
  // плюс модалки поверх (настройки и т.п.) — на мобилке полноэкранные и
  // тоже закрываются "назад". На ПК всё видно разом (grid-колонки) или как
  // обычная модалка, isMobile здесь нужен только для истории браузера. ---
  const isMobile = useIsMobile()
  const [mobileScreen, setMobileScreen] = useState<'nav' | 'content'>('nav')
  // Стек "слоёв" мобильной навигации, каждый — одна pushState-запись в
  // истории браузера. Popstate снимает верхний слой и откатывает именно
  // его (закрывает то, что было открыто ПОСЛЕДНИМ — например настройки
  // поверх открытого канала — а не всегда возвращает на список каналов).
  const mobileBackStack = useRef<Array<() => void>>([])
  const pushMobileLayer = useCallback(
    (onPop: () => void) => {
      if (!isMobile) return
      history.pushState({ pskovcordMobile: true }, '')
      mobileBackStack.current.push(onPop)
    },
    [isMobile],
  )
  useEffect(() => {
    const onPopState = () => {
      const undo = mobileBackStack.current.pop()
      undo?.()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const goBackMobile = useCallback(() => {
    history.back()
  }, [])
  const navigateToContent = useCallback(() => {
    // Уже в content и просто переключились на другой канал/диалог — слой
    // истории не плодим, там нечего откатывать (мобильный "экран" тот же).
    if (!isMobile || mobileScreen === 'content') return
    pushMobileLayer(() => setMobileScreen('nav'))
    setMobileScreen('content')
  }, [isMobile, mobileScreen, pushMobileLayer])

  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState<number | null>(null)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  // Читаются в обработчике "ready" (добор пропущенного) — через ref, чтобы не
  // тащить их в зависимости большого gateway-эффекта.
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const [voice, setVoice] = useState<VoiceState | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('connecting')
  // Актуальный voice для обработчиков событий. Нужен, чтобы решения «мы сейчас
  // в этом канале?» принимались СНАРУЖИ апдейтеров setVoice: React.StrictMode
  // намеренно вызывает апдейтеры дважды, ловя нарушения их чистоты, — и
  // побочки внутри них (alert, отправка в сокет) срабатывали по два раза.
  const voiceRef = useRef<VoiceState | null>(voice)
  voiceRef.current = voice
  const userRef = useRef(user)
  userRef.current = user
  const [showDiscover, setShowDiscover] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  // Переключатель списка участников сервера (иконка в chat-header текстового
  // канала) — сам список в принципе показывается только для текстового
  // канала (см. members-list ниже по currentChannel.kind), этот тумблер —
  // ещё один слой поверх: можно спрятать его и сидя в тексте.
  const [showMembersList, setShowMembersList] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  // Настройки на мобилке — полноэкранный "слой" поверх текущего экрана
  // (nav или content), а не центрированная модалка, и закрываются так же
  // "назад", как и переход в content (см. pushMobileLayer выше).
  const openMobileSettings = useCallback(() => {
    pushMobileLayer(() => setShowSettings(false))
    setShowSettings(true)
  }, [pushMobileLayer])
  const closeSettings = useCallback(() => {
    if (isMobile) goBackMobile()
    else setShowSettings(false)
  }, [isMobile, goBackMobile])
  const [showProfile, setShowProfile] = useState(false)
  const [profilePopup, setProfilePopup] = useState<ProfilePopupTarget | null>(null)
  const [replyTarget, setReplyTarget] = useState<ChatMessageBase | null>(null)
  const [editTarget, setEditTarget] = useState<ChatMessageBase | null>(null)
  // --- контекстное меню участника голосового канала (правый клик) --------
  const [contextMenuTarget, setContextMenuTarget] = useState<ParticipantContextMenuTarget | null>(
    null,
  )
  const [mentionPrefill, setMentionPrefill] = useState<MessageInputPrefill | null>(null)
  // channel_id канала, где ПРЯМО СЕЙЧАС идёт голосование за мут (по кому бы
  // то ни было) — используется, только чтобы задизейблить «начать ещё одно»
  // в ParticipantContextMenu; сам факт голосования и его результат живут в
  // muteVote/voice_mute_vote_result отдельно.
  const [activeMuteVoteChannelId, setActiveMuteVoteChannelId] = useState<number | null>(null)
  const [muteVote, setMuteVote] = useState<{
    channelId: number
    targetUserId: number
    endsAt: number
  } | null>(null)

  // --- домашний экран: диалоги/группы, друзья, звонки в них -------------
  const [conversations, setConversations] = useState<Conversation[]>([])
  // Как и voiceRef: читаем в обработчиках через ref, чтобы conversations не
  // висел в зависимостях большого gateway-эффекта. Раньше висел — и любое
  // входящее ЛС меняло список, эффект пересоздавался и заново
  // переподписывал все ~24 обработчика; сообщение, пришедшее в окне между
  // отпиской и подпиской, мог потерять любой из них.
  const conversationsRef = useRef<Conversation[]>([])
  conversationsRef.current = conversations
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)
  const [dmMessages, setDmMessages] = useState<ConversationMessage[]>([])
  const dmMessagesRef = useRef<ConversationMessage[]>([])
  dmMessagesRef.current = dmMessages
  const [dmReplyTarget, setDmReplyTarget] = useState<ChatMessageBase | null>(null)
  const [dmEditTarget, setDmEditTarget] = useState<ChatMessageBase | null>(null)
  // Диалоги с непрочитанными сообщениями — клиентское состояние (бэкенд не
  // хранит read-статус), сбрасывается при перезагрузке. Наполняется в
  // gateway.on('dm_message_create') ниже, чистится при открытии диалога (см.
  // handleSelectConversation) — используется для общего счётчика уведомлений
  // на домашней пилюле рельсы (см. ServerRail.notificationCount).
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<number>>(new Set())
  const [friends, setFriends] = useState<FriendsState>({ friends: [], incoming: [], outgoing: [] })
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [knownPeople, setKnownPeople] = useState<KnownPerson[]>([])
  // Участники ЗВОНКА в диалоге/группе — параллельно members (те — только
  // для серверных голосовых каналов). id => краткая карточка для отрисовки,
  // приходит прямо в событии (dm_voice_state_update) — отдельно грузить не нужно.
  const [dmCallParticipants, setDmCallParticipants] = useState<Record<number, CallParticipant>>({})
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  // Аналог pendingWatch, но для демонстрации экрана в звонке диалога/группы —
  // отдельное состояние, потому что pendingWatch завязан на channelId сервера.
  const [dmPendingWatchUserId, setDmPendingWatchUserId] = useState<number | null>(null)
  // Высота VoiceStage над текстовым чатом в открытом диалоге/группе — тянется
  // за resize-handle (см. handleDmVoiceStageResizeStart), персональна для
  // сессии (не сохраняется между перезагрузками — не критично).
  const [dmVoiceStageHeight, setDmVoiceStageHeight] = useState(320)
  // userId, чью демонстрацию нужно автоматически начать смотреть в
  // указанном голосовом канале, как только она станет доступна — ставится
  // кликом по бейджу «демка» или по превью в VoiceStage (см. handleWatchScreen).
  const [pendingWatch, setPendingWatch] = useState<{ channelId: number; userId: number } | null>(
    null,
  )

  // --- уведомления серверов: роли/ростеры всех серверов, непрочитанные ---
  // Роли и полные ростеры (с role_ids) ВСЕХ серверов, где мы состоим — нужны
  // для подсчёта упоминаний (см. mentions.ts) в ФОНОВЫХ серверах: `members`
  // выше — только ростер сейчас ВЫБРАННОГО сервера. Дружеский масштаб
  // проекта (см. комментарии по всему бэку) делает такую загрузку разумной.
  const [serverRoles, setServerRoles] = useState<Record<number, Role[]>>({})
  const [serverMembersCache, setServerMembersCache] = useState<Record<number, Member[]>>({})
  const fetchedServerDataIds = useRef<Set<number>>(new Set())
  const serversRef = useRef<Server[]>([])
  serversRef.current = servers

  // Непрочитанные текстовые каналы — тот же приём, что и unreadConversationIds
  // выше: чисто клиентское, эфемерное состояние (сбрасывается при перезагрузке
  // страницы), наполняется в message_create ниже, чистится при открытии
  // канала/«Отметить как прочитанное» (см. handleSelectChannel/handleMarkServerRead).
  const [unreadChannelIds, setUnreadChannelIds] = useState<Set<number>>(new Set())

  // Раз в 30с — форсирует пересчёт "заглушено ли ПРЯМО СЕЙЧАС": muted_until
  // может истечь без единого нового события, и без этого тика бейдж/пункт
  // меню молча оставались бы "заглушено" ещё сколько-то после истечения.
  const [muteTick, setMuteTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setMuteTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // --- контекстное меню сервера (правый клик в ServerRail) и его модалки ---
  // Держим только id, не сам объект: настройки в серверном меню (мьют,
  // уровень уведомлений) меняются кликом ВНУТРИ этого же меню — со снимком
  // сервера, захваченным в момент правого клика, чекбоксы после клика не
  // обновились бы, потому что patchServerSettings меняет `servers`, а не
  // этот снимок. Резолвим актуальный объект из `servers` при каждом рендере.
  const [serverContextMenuServerId, setServerContextMenuServerId] = useState<{
    id: number
    x: number
    y: number
  } | null>(null)
  const [showServerInviteId, setShowServerInviteId] = useState<number | null>(null)
  const [showServerPrivacyId, setShowServerPrivacyId] = useState<number | null>(null)

  const currentServer = servers.find((s) => s.id === serverId) || null
  const channels = currentServer?.channels || []
  const currentChannel = channels.find((c) => c.id === channelId) || null

  // --- очередь исходящих (статусы доставки, ретраи, черновики) -----------
  // Транспорт ставится отдельно от самой очереди: outbox живёт вне React (его
  // таймеры ретраев не должны умирать при переключении канала), поэтому
  // способ «как отправить» ему передаётся снаружи.
  useEffect(() => {
    outbox.setTransport((message) => {
      const opts = {
        replyTo: message.replyTo,
        attachmentIds: message.attachments.map((a) => a.id),
        nonce: message.nonce,
      }
      if (message.target.kind === 'channel') {
        gateway.sendMessage(message.target.id, message.content, opts)
      } else {
        gateway.dmSendMessage(message.target.id, message.content, opts)
      }
    })
    return () => outbox.setTransport(null)
  }, [gateway])

  const channelTarget: OutboxTarget | null =
    currentChannel?.kind === 'text' ? { kind: 'channel', id: currentChannel.id } : null
  const conversationTarget: OutboxTarget | null =
    activeConversationId != null
      ? { kind: 'conversation', id: activeConversationId }
      : null
  const pendingChannelMessages = usePendingMessages(channelTarget)
  const pendingDmMessages = usePendingMessages(conversationTarget)
  // Модерация чата — по праву роли (владельцу chat/roles.py выдаёт всё).
  const canDeleteMessages = !!currentServer?.my_permissions?.delete_messages
  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null
  const dmRoster: VoiceRosterMember[] = Object.values(dmCallParticipants).map((p) => ({
    id: p.id, username: p.username, avatar_color: p.avatar_color, avatar_image: p.avatar_image,
    muted: p.muted, deafened: p.deafened, sharing_screen: p.sharing_screen,
  }))
  const isInDmCall =
    voice?.room.kind === 'conversation' && activeConversation != null && voice.room.id === activeConversation.id

  // Для Блока 2 в StatusMenu (мини-карточка "сейчас в голосовом") — тот же
  // ростер, что уже собирается инлайново для VoiceStage по каналу/диалогу,
  // просто в одном месте и объединённый для обоих видов звонка. У диалогов
  // топика нет (см. api.ts Conversation) — редактируемый статус звонка есть
  // только у серверных голосовых каналов.
  const voiceRoster: VoiceRosterMember[] = useMemo(() => {
    if (voice?.room.kind === 'channel') {
      return members.filter((m) => m.voice_channel === String(voice.room.id))
    }
    if (voice?.room.kind === 'conversation') return dmRoster
    return []
  }, [voice, members, dmRoster])
  const voiceTopic: string | null = useMemo(() => {
    if (voice?.room.kind !== 'channel') return null
    return channels.find((c) => c.id === Number(voice.room.id))?.topic ?? null
  }, [voice, channels])

  // --- уведомления серверов: производные значения --------------------------
  const isServerMutedNow = useCallback((s: Server): boolean => {
    const settings = s.my_settings
    if (!settings) return false
    if (settings.muted_forever) return true
    if (!settings.muted_until) return false
    return new Date(settings.muted_until).getTime() > Date.now()
  }, [])

  // muteTick форсирует пересчёт по таймеру (см. выше) — сам он в теле не
  // используется (isServerMutedNow сверяется с Date.now() напрямую), только
  // как повод для React пересчитать useMemo; поэтому линтер и не видит его
  // "нужным" — но без него пересчёт не произойдёт вовсе, пока не изменится
  // сам список серверов.
  const mutedServerIds = useMemo(
    () => new Set(servers.filter((s) => isServerMutedNow(s)).map((s) => s.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [servers, isServerMutedNow, muteTick],
  )

  const unreadServerIds = useMemo(() => {
    const ids = new Set<number>()
    for (const s of servers) {
      if (s.channels.some((c) => unreadChannelIds.has(c.id))) ids.add(s.id)
    }
    return ids
  }, [servers, unreadChannelIds])

  // channel_id -> server_id, для message_create по ФОНОВОМУ каналу (там
  // приходит только id канала, не сервера).
  const channelServerId = useMemo(() => {
    const map: Record<number, number> = {}
    for (const s of servers) {
      for (const c of s.channels) map[c.id] = s.id
    }
    return map
  }, [servers])

  // Полный ростер сервера: для СЕЙЧАС открытого — свежий `members`, для
  // фоновых — кэш (см. serverMembersCache выше, чуть менее свежий).
  const membersForServer = useCallback(
    (id: number): Member[] => (id === serverId ? members : serverMembersCache[id] ?? []),
    [serverId, members, serverMembersCache],
  )
  const rolesForServer = useCallback(
    (id: number): Role[] => serverRoles[id] ?? [],
    [serverRoles],
  )

  // Поднимать ли непрочитанное на сообщение из чужого канала — с учётом
  // мьюта, уровня уведомлений и (при notification_level='mentions')
  // упоминания — личного, @all/@here или ролевого (см. mentions.ts).
  const shouldNotifyForChannel = useCallback(
    (ownerServerId: number, authorId: number, content: string): boolean => {
      if (authorId === userRef.current?.id) return false
      const server = serversRef.current.find((s) => s.id === ownerServerId)
      const settings = server?.my_settings
      if (!server || !settings) return true
      if (isServerMutedNow(server)) return false
      if (settings.notification_level === 'none') return false
      if (settings.notification_level === 'all') return true
      const roster = membersForServer(ownerServerId)
      const me = roster.find((m) => m.id === userRef.current?.id)
      const author = roster.find((m) => m.id === authorId)
      return isMentioned(content, {
        myUsername: userRef.current?.username ?? '',
        myRoleIds: me?.role_ids ?? [],
        authorRoleIds: author?.role_ids ?? [],
        roles: rolesForServer(ownerServerId),
        ignoreAtHere: settings.ignore_at_here,
        suppressRoleMentions: settings.suppress_role_mentions,
      })
    },
    [isServerMutedNow, membersForServer, rolesForServer],
  )
  // Читается ИЗ большого gateway-эффекта через ref — тот, как и voiceRef/
  // conversationsRef рядом, намеренно не держит быстро меняющиеся значения в
  // зависимостях (иначе каждое новое сообщение фонового сервера
  // пересоздавало бы все ~30 обработчиков подряд).
  const shouldNotifyRef = useRef(shouldNotifyForChannel)
  shouldNotifyRef.current = shouldNotifyForChannel
  const channelServerIdRef = useRef<Record<number, number>>({})
  channelServerIdRef.current = channelServerId

  const selectServer = useCallback((s: Server) => {
    setServerId(s.id)
    const firstText = s.channels.find((c) => c.kind === 'text')
    const target = firstText ? firstText.id : (s.channels[0]?.id ?? null)
    setChannelId(target)
    // Заодно гасим непрочитанное у канала, в который переключаемся — иначе
    // клик по серверу открывал бы канал, у которого пилюля всё ещё "непрочитан".
    if (target != null) {
      setUnreadChannelIds((prev) => {
        if (!prev.has(target)) return prev
        const next = new Set(prev)
        next.delete(target)
        return next
      })
    }
  }, [])

  // Начальная загрузка серверов.
  useEffect(() => {
    ;(async () => {
      const list = await api.servers()
      setServers(list)
      if (list.length) selectServer(list[0])
    })()
  }, [selectServer])

  // Участники при смене сервера. Отдельным callback'ом, потому что после
  // выдачи роли/кика/бана из редактора сервера список нужно перечитать.
  const reloadMembers = useCallback(async () => {
    if (serverId == null) return
    try {
      setMembers(await api.members(serverId))
    } catch {
      setMembers([])
    }
  }, [serverId])

  useEffect(() => {
    void reloadMembers()
  }, [reloadMembers])

  // Роли + полный ростер КАЖДОГО сервера, где мы состоим — один раз на
  // сервер (см. serverRoles/serverMembersCache выше). Список серверов меняется
  // редко (вступил/вышел), поэтому дозагружаем только НОВЫЕ id.
  useEffect(() => {
    const toFetch = servers.filter((s) => !fetchedServerDataIds.current.has(s.id))
    if (toFetch.length === 0) return
    toFetch.forEach((s) => fetchedServerDataIds.current.add(s.id))
    void (async () => {
      for (const s of toFetch) {
        try {
          const [roleList, memberList] = await Promise.all([api.roles(s.id), api.members(s.id)])
          setServerRoles((prev) => ({ ...prev, [s.id]: roleList }))
          setServerMembersCache((prev) => ({ ...prev, [s.id]: memberList }))
        } catch {
          // Не удалось — попробуем снова при следующем изменении списка
          // серверов (вступление/выход куда угодно перезапускает этот эффект).
          fetchedServerDataIds.current.delete(s.id)
        }
      }
    })()
  }, [servers])

  // Роли ИМЕННО открытого сейчас сервера освежаем при каждом переключении —
  // используются и для подсчёта упоминаний, и потенциально устарели в общем
  // кэше выше (кто-то мог поправить mentionable_by, пока сервер был фоновым).
  useEffect(() => {
    if (serverId == null) return
    void (async () => {
      try {
        const list = await api.roles(serverId)
        setServerRoles((prev) => ({ ...prev, [serverId]: list }))
      } catch {
        /* используем то, что уже в кэше */
      }
    })()
  }, [serverId])

  // Диалоги/группы и друзья — не завязаны на выбранный сервер, нужны сразу
  // (бейджи, домашний экран в любой момент). Приглашения на сервера теперь
  // приходят карточкой прямо в историю диалога (см. ConversationMessage.
  // server_invite) — отдельно грузить их не нужно.
  useEffect(() => {
    ;(async () => {
      try {
        setConversations(await api.conversations())
      } catch {
        setConversations([])
      }
      try {
        setFriends(await api.friends())
      } catch {
        setFriends({ friends: [], incoming: [], outgoing: [] })
      }
    })()
  }, [])

  // Ссылка-приглашение (?invite=<код>) — редимпшен один раз при загрузке.
  // Параметр убирается из URL сразу: ссылка многоразовая, но повторно дёргать
  // API на каждый ре-рендер/перезагрузку той же вкладки незачем.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const code = params.get('invite')
    if (!code) return
    const url = new URL(location.href)
    url.searchParams.delete('invite')
    window.history.replaceState({}, '', url.toString())
    void (async () => {
      try {
        const server = await api.redeemServerInvite(code)
        setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]))
        selectServer(server)
      } catch (e) {
        alert('Не удалось войти по ссылке-приглашению: ' + (e as Error).message)
      }
    })()
  }, [selectServer])

  // История сообщений выбранного диалога/группы.
  useEffect(() => {
    setDmReplyTarget(null)
    setDmEditTarget(null)
    if (activeConversationId == null) {
      setDmMessages([])
      return
    }
    ;(async () => {
      try {
        setDmMessages(await api.conversationMessages(activeConversationId))
      } catch {
        setDmMessages([])
      }
    })()
  }, [activeConversationId])

  // Список людей для пикера «новый диалог/группа» И «Пригласить на сервер» —
  // обновляем при каждом открытии любой из двух модалок (мог появиться новый
  // общий сервер/друг с прошлого раза).
  useEffect(() => {
    if (!showNewConversation && showServerInviteId == null) return
    ;(async () => {
      try {
        setKnownPeople(await api.knownPeople())
      } catch {
        setKnownPeople([])
      }
    })()
  }, [showNewConversation, showServerInviteId])

  // История сообщений при смене текстового канала.
  useEffect(() => {
    setReplyTarget(null)
    setEditTarget(null)
    if (!currentChannel || currentChannel.kind !== 'text') {
      setMessages([])
      return
    }
    ;(async () => {
      try {
        setMessages(await api.messages(currentChannel.id))
      } catch {
        setMessages([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  // Realtime-события gateway.
  useEffect(() => {
    const offMsg = gateway.on('message_create', (d) => {
      // Эхо собственной отправки: nonce закрывает статус «отправляется» и
      // убирает оптимистичную копию из очереди — настоящее сообщение
      // добавляется тут же строкой ниже (см. outbox.ack).
      if (d.nonce) outbox.ack(d.nonce)
      if (d.message.channel === channelId) {
        setMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
        )
        return
      }
      // Не открытый прямо сейчас канал — решаем, поднимать ли непрочитанное
      // (мьют/уровень уведомлений/упоминание, см. shouldNotifyForChannel).
      const ownerServerId = channelServerIdRef.current[d.message.channel]
      if (
        ownerServerId != null &&
        shouldNotifyRef.current(ownerServerId, d.message.author.id, d.message.content)
      ) {
        setUnreadChannelIds((prev) =>
          prev.has(d.message.channel) ? prev : new Set(prev).add(d.message.channel),
        )
      }
    })
    // Подтверждение ПОВТОРНОЙ попытки: сообщение создала прошлая, эхо до нас
    // не дошло. Само сообщение доберётся обычным путём (перечитыванием
    // истории на "ready"), здесь важно лишь снять статус «отправляется».
    const offMsgAck = gateway.on('message_ack', (d) => {
      if (d.nonce) outbox.ack(d.nonce)
    })
    const offMsgNack = gateway.on('message_nack', (d) => {
      if (d.nonce) outbox.nack(d.nonce, d.reason)
    })
    const offReactions = gateway.on('message_reactions', (d) => {
      if (d.channel_id !== channelId) return
      setMessages((prev) =>
        prev.map((m) => (m.id === d.message_id ? { ...m, reactions: d.reactions } : m)),
      )
    })
    const offMsgDelete = gateway.on('message_delete', (d) => {
      if (d.channel_id !== channelId) return
      setMessages((prev) => prev.filter((m) => m.id !== d.message_id))
    })
    const offMsgUpdate = gateway.on('message_update', (d) => {
      if (d.message.channel !== channelId) return
      setMessages((prev) =>
        prev.map((m) => (m.id === d.message.id ? d.message : m)),
      )
    })
    const offPresence = gateway.on('presence_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, online: d.online, status: d.status } : m,
        ),
      )
    })
    const offVoice = gateway.on('voice_state_update', (d) => {
      if (d.server_id !== serverId) return // событие не про текущий сервер
      const vc = d.channel_id ? String(d.channel_id) : null
      setMembers((prev) => {
        if (prev.some((m) => m.id === d.user_id)) {
          return prev.map((m) =>
            m.id === d.user_id ? { ...m, voice_channel: vc, online: true } : m,
          )
        }
        // Участник, которого ещё не было в загруженном списке — добавляем сразу.
        // Раз он в голосе — статус по умолчанию 'online' (voice_state_update
        // не несёт эффективный статус; уточнится следующим presence_update).
        return [
          ...prev,
          {
            id: d.user_id,
            username: d.username,
            display_name: d.display_name ?? '',
            avatar_color: d.avatar_color,
            avatar_image: d.avatar_image ?? '',
            banner_gradient: '',
            banner_image: '',
            online: true,
            status: 'online' as const,
            voice_channel: vc,
            muted: false,
            deafened: false,
            sharing_screen: false,
            // Роли/владение приходят только из api.members() — здесь их нет,
            // ставим пустые: строка ростера ими не пользуется, а редактор
            // сервера работает с перезагруженным списком (reloadMembers).
            role_ids: [],
            is_owner: false,
          },
        ]
      })
    })
    // Статус мьюта/дефена — глобально для всех, не только для тех, кто сам
    // в этом голосовом канале (иначе кольцо/значки видны только "изнутри").
    const offMicStatus = gateway.on('voice_mute_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, muted: !!d.muted, deafened: !!d.deafened } : m,
        ),
      )
      // Тот же op обслуживает и звонки в диалогах/группах (сервер сам
      // различает по текущей комнате — см. chat.consumers._send_to_room_group);
      // применяем и туда, если этот userId сейчас в roster'е звонка.
      setDmCallParticipants((prev) =>
        prev[d.user_id]
          ? { ...prev, [d.user_id]: { ...prev[d.user_id], muted: !!d.muted, deafened: !!d.deafened } }
          : prev,
      )
    })
    // Демонстрация экрана — тоже глобально, чтобы бейдж «демка» и клик по
    // нему работали даже для тех, кто сам не подключён к этому каналу.
    const offScreenShare = gateway.on('voice_screen_share_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, sharing_screen: !!d.sharing } : m,
        ),
      )
      setDmCallParticipants((prev) =>
        prev[d.user_id]
          ? { ...prev, [d.user_id]: { ...prev[d.user_id], sharing_screen: !!d.sharing } }
          : prev,
      )
    })
    // Нас принудительно отключили от голосового канала (см.
    // handleDisconnectUser/chat.consumers._handle_voice_disconnect_user).
    const offVoiceKicked = gateway.on('voice_kicked', (d) => {
      const current = voiceRef.current
      if (!current || current.room.kind !== 'channel' || current.room.id !== d.channel_id) {
        return
      }
      gateway.voiceLeave()
      setVoice(null)
      alert('Вас отключили от голосового канала.')
    })
    // Голос начался на другом устройстве/вкладке того же аккаунта (см.
    // chat.consumers._kick_other_devices) — один аккаунт не может быть в
    // голосе на двух устройствах разом. voice_leave здесь НЕ шлём: presence
    // на сервере уже атомарно указывает на НОВОЕ устройство (см.
    // presence.join_voice), обычный voice_leave стёр бы именно её.
    const offVoiceKickedOtherDevice = gateway.on('voice_kicked_other_device', () => {
      if (!voiceRef.current) return
      setVoice(null)
      alert('Вы подключились к голосу с другого устройства — здесь звонок завершён.')
    })
    // Новое голосование за мут в каком-то голосовом канале сервера — модалку
    // показываем, только если это канал, в котором мы сейчас сами сидим, и
    // цель — не мы (у цели голосования такого меню/модалки просто нет).
    const offMuteVoteStart = gateway.on('voice_mute_vote_start', (d) => {
      setActiveMuteVoteChannelId(d.channel_id)
      setMuteVote((prev) => {
        const current = voiceRef.current
        if (
          current?.room.kind === 'channel' &&
          current.room.id === d.channel_id &&
          d.target_user_id !== userRef.current?.id
        ) {
          return { channelId: d.channel_id, targetUserId: d.target_user_id, endsAt: d.ends_at }
        }
        return prev
      })
    })
    const offMuteVoteResult = gateway.on('voice_mute_vote_result', (d) => {
      setActiveMuteVoteChannelId((prev) => (prev === d.channel_id ? null : prev))
      setMuteVote((prev) => (prev && prev.channelId === d.channel_id ? null : prev))
    })
    // Кто-то из того же голосового канала попросил нас включить демонстрацию —
    // только звук (см. задачу), никакой модалки.
    const offScreenShareRequested = gateway.on('voice_screen_share_requested', (d) => {
      const current = voiceRef.current
      if (current?.room.kind === 'channel' && current.room.id === d.channel_id) {
        playScreenShareRequestSound()
      }
    })
    // Смена ника/аватара — свою уже применили локально сразу после ответа
    // PATCH /api/auth/me (см. handleProfileUpdated), но остальным участникам
    // и старым сообщениям в списке нужно обновиться этим же событием.
    const offProfileUpdate = gateway.on('profile_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id
            ? {
                ...m,
                username: d.username,
                display_name: d.display_name,
                avatar_color: d.avatar_color,
                avatar_image: d.avatar_image,
              }
            : m,
        ),
      )
    })
    const offChannelCreate = gateway.on('channel_create', (d) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === d.server_id
            ? {
                ...s,
                channels: s.channels.some((c) => c.id === d.channel.id)
                  ? s.channels
                  : [...s.channels, d.channel],
              }
            : s,
        ),
      )
    })
    // Настройки сервера изменил кто-то другой (редактор сервера). Свои
    // права (my_permissions) в событие не кладутся — они у каждого свои,
    // поэтому мержим только «общие» поля поверх уже загруженного сервера.
    const offServerUpdate = gateway.on('server_update', (d) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === d.server.id
            ? { ...s, ...d.server, channels: s.channels, my_permissions: s.my_permissions }
            : s,
        ),
      )
    })
    // Нашу заявку на вступление одобрили — сервер появляется в списке сразу.
    const offJoinApproved = gateway.on('server_join_approved', (d) => {
      setServers((prev) => (prev.some((s) => s.id === d.server.id) ? prev : [...prev, d.server]))
    })
    const offCallState = gateway.on('voice_call_state', (d) => {
      setServers((prev) =>
        prev.map((s) => ({
          ...s,
          channels: s.channels.map((c) =>
            c.id === d.channel_id
              ? { ...c, call_started_at: d.call_started_at, topic: d.topic }
              : c,
          ),
        })),
      )
    })

    // --- домашний экран: диалоги/группы/друзья/звонки ---------------------
    const offDmReactions = gateway.on('dm_message_reactions', (d) => {
      if (d.conversation_id !== activeConversationId) return
      setDmMessages((prev) =>
        prev.map((m) => (m.id === d.message_id ? { ...m, reactions: d.reactions } : m)),
      )
    })
    const offDmMsg = gateway.on('dm_message_create', (d) => {
      if (d.nonce) outbox.ack(d.nonce)
      if (d.message.conversation === activeConversationId) {
        setDmMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
        )
      }
      // Непрочитанное — чужое сообщение в диалог, который прямо сейчас не
      // открыт (домашний экран должен быть виден И это должен быть именно
      // этот диалог — activeConversationId не сбрасывается при переходе на
      // сервер, поэтому одной проверки id диалога недостаточно).
      const isViewingThisConversation =
        serverId == null && d.message.conversation === activeConversationId
      if (d.message.author.id !== userRef.current?.id && !isViewingThisConversation) {
        setUnreadConversationIds((prev) =>
          prev.has(d.message.conversation) ? prev : new Set(prev).add(d.message.conversation),
        )
      }
      // Превью последнего сообщения в списке диалогов — обновляем всегда,
      // даже если сейчас открыт другой диалог.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === d.message.conversation
            ? {
                ...c,
                last_message: {
                  content: d.message.content,
                  author_id: d.message.author.id,
                  created_at: d.message.created_at,
                },
              }
            : c,
        ),
      )
    })
    const offDmMsgDelete = gateway.on('dm_message_delete', (d) => {
      if (d.conversation_id !== activeConversationId) return
      setDmMessages((prev) => prev.filter((m) => m.id !== d.message_id))
    })
    const offDmMsgUpdate = gateway.on('dm_message_update', (d) => {
      if (d.message.conversation !== activeConversationId) return
      setDmMessages((prev) => prev.map((m) => (m.id === d.message.id ? d.message : m)))
    })
    const offConversationCreate = gateway.on('conversation_create', (d) => {
      setConversations((prev) =>
        prev.some((c) => c.id === d.conversation.id)
          ? prev.map((c) => (c.id === d.conversation.id ? d.conversation : c))
          : [d.conversation, ...prev],
      )
    })
    const offDmVoice = gateway.on('dm_voice_state_update', (d) => {
      // Ростер звонка привязан к комнате АКТИВНОГО ЗВОНКА (voice.room), а не
      // к тому, чей диалог сейчас открыт в чате — можно писать в одном
      // диалоге, оставаясь в звонке другого.
      const activeCall = voiceRef.current
      if (activeCall?.room.kind !== 'conversation' || activeCall.room.id !== d.conversation_id) {
        return
      }
      setDmCallParticipants((prev) => {
        const next = { ...prev }
        if (d.in_call) {
          next[d.user_id] = {
            id: d.user_id, username: d.username,
            avatar_color: d.avatar_color, avatar_image: d.avatar_image,
            muted: false, deafened: false, sharing_screen: false,
          }
        } else {
          delete next[d.user_id]
        }
        return next
      })
    })
    // Начальный список пиров сразу после СВОЕГО входа в звонок — приходит
    // только с id (без username/аватара), достаём их из уже загруженных
    // participants активного диалога (см. api.conversations()).
    const offDmPeers = gateway.on('dm_voice_peers', (d) => {
      const activeCall = voiceRef.current
      if (activeCall?.room.kind !== 'conversation' || activeCall.room.id !== d.conversation_id) {
        return
      }
      const conv = conversationsRef.current.find((c) => c.id === d.conversation_id)
      const lookup = new Map((conv?.participants ?? []).map((p) => [p.id, p]))
      const peerFlags = (d.peer_flags ?? {}) as Record<
        number, { muted?: boolean; deafened?: boolean; sharing_screen?: boolean }
      >
      setDmCallParticipants((prev) => {
        const next = { ...prev }
        for (const id of d.peer_ids as number[]) {
          const p = lookup.get(id)
          if (p) {
            const flags = peerFlags[id] ?? {}
            next[id] = {
              id: p.id, username: p.username,
              avatar_color: p.avatar_color, avatar_image: p.avatar_image,
              muted: !!flags.muted, deafened: !!flags.deafened,
              sharing_screen: !!flags.sharing_screen,
            }
          }
        }
        return next
      })
    })
    const offCallRing = gateway.on('conversation_call_ring', (d) => {
      // Не звоним сами себе, если уже в этом звонке (второй таб/устройство).
      const activeCall = voiceRef.current
      if (activeCall?.room.kind === 'conversation' && activeCall.room.id === d.conversation_id) {
        return
      }
      setIncomingCall({ conversationId: d.conversation_id, caller: d.caller })
    })
    const offFriendRequestCreate = gateway.on('friend_request_create', (d) => {
      setFriends((prev) => ({
        ...prev,
        incoming: [...prev.incoming, { id: d.id, user: d.from_user }],
      }))
    })
    const offFriendRequestAccept = gateway.on('friend_request_accept', (d) => {
      setFriends((prev) => ({
        friends: [...prev.friends, d.user],
        incoming: prev.incoming.filter((r) => r.id !== d.id),
        outgoing: prev.outgoing.filter((r) => r.id !== d.id),
      }))
    })

    // Каждый (пере)коннект gateway начинается с "ready". Пока сокет лежал,
    // сообщения продолжали приходить другим — а этот клиент их не получал и
    // раньше не добирал никогда: они не появлялись до переключения канала.
    // Курсор after=<последний известный id> закрывает ровно этот разрыв.
    const offReady = gateway.on('ready', () => {
      // Сокет снова жив — немедленно повторяем всё, что висит неотправленным,
      // не дожидаясь их собственных таймеров ретрая. Дубля не будет: сервер
      // узнаёт попытку по nonce (см. chat/consumers.py).
      outbox.flush()
      void (async () => {
        const lastMessage = messagesRef.current[messagesRef.current.length - 1]
        if (channelId != null && lastMessage) {
          try {
            const missed = await api.messages(channelId, { after: lastMessage.id })
            if (missed.length) {
              setMessages((prev) => {
                const known = new Set(prev.map((m) => m.id))
                return [...prev, ...missed.filter((m) => !known.has(m.id))]
              })
            }
          } catch {
            /* добор не критичен — история перечитается при смене канала */
          }
        }
        const lastDm = dmMessagesRef.current[dmMessagesRef.current.length - 1]
        if (activeConversationId != null && lastDm) {
          try {
            const missed = await api.conversationMessages(activeConversationId, {
              after: lastDm.id,
            })
            if (missed.length) {
              setDmMessages((prev) => {
                const known = new Set(prev.map((m) => m.id))
                return [...prev, ...missed.filter((m) => !known.has(m.id))]
              })
            }
          } catch {
            /* см. выше */
          }
        }
      })()
    })

    // Членство на сервере изменилось при живом сокете. Сама подписка/отписка
    // от группы сервера делается на стороне консьюмера (см. chat/consumers.py,
    // op'ы server_membership_*) — здесь только приводим UI в соответствие.
    const offMembershipGranted = gateway.on('server_membership_granted', () => {
      void (async () => {
        try {
          setServers(await api.servers())
        } catch {
          /* перечитаем при следующем событии */
        }
      })()
    })
    const offMembershipRevoked = gateway.on('server_membership_revoked', (d) => {
      setServers((prev) => prev.filter((s) => s.id !== d.server_id))
      // Чистим и всё, что было насчитано/закэшировано для этого сервера —
      // иначе кэши ролей/ростеров/непрочитанного растут по серверам, из
      // которых давно вышли.
      const leaving = serversRef.current.find((s) => s.id === d.server_id)
      if (leaving) {
        const leavingChannelIds = new Set(leaving.channels.map((c) => c.id))
        setUnreadChannelIds((prev) => {
          if (![...leavingChannelIds].some((id) => prev.has(id))) return prev
          const next = new Set(prev)
          leavingChannelIds.forEach((id) => next.delete(id))
          return next
        })
      }
      fetchedServerDataIds.current.delete(d.server_id)
      setServerRoles((prev) => {
        if (!(d.server_id in prev)) return prev
        const next = { ...prev }
        delete next[d.server_id]
        return next
      })
      setServerMembersCache((prev) => {
        if (!(d.server_id in prev)) return prev
        const next = { ...prev }
        delete next[d.server_id]
        return next
      })
      if (serverId === d.server_id) {
        setServerId(null)
        setChannelId(null)
      }
    })
    // Мы сами вышли из беседы (см. api.leaveConversation).
    const offConversationLeft = gateway.on('conversation_left', (d) => {
      setConversations((prev) => prev.filter((c) => c.id !== d.conversation_id))
      if (activeConversationId === d.conversation_id) setActiveConversationId(null)
    })
    // Из беседы вышел кто-то другой — убрать из списка участников и из
    // ростера звонка, если он там был.
    const offParticipantLeave = gateway.on('conversation_participant_leave', (d) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === d.conversation_id
            ? { ...c, participants: c.participants.filter((p) => p.id !== d.user_id) }
            : c,
        ),
      )
      setDmCallParticipants((prev) => {
        if (!prev[d.user_id]) return prev
        const next = { ...prev }
        delete next[d.user_id]
        return next
      })
    })

    return () => {
      offMsg()
      offMsgAck()
      offMsgNack()
      offReactions()
      offDmReactions()
      offMsgDelete()
      offMsgUpdate()
      offPresence()
      offVoice()
      offMicStatus()
      offScreenShare()
      offVoiceKicked()
      offVoiceKickedOtherDevice()
      offMuteVoteStart()
      offMuteVoteResult()
      offScreenShareRequested()
      offProfileUpdate()
      offChannelCreate()
      offServerUpdate()
      offJoinApproved()
      offCallState()
      offDmMsg()
      offDmMsgDelete()
      offDmMsgUpdate()
      offConversationCreate()
      offDmVoice()
      offDmPeers()
      offCallRing()
      offFriendRequestCreate()
      offFriendRequestAccept()
      offMembershipGranted()
      offMembershipRevoked()
      offConversationLeft()
      offParticipantLeave()
      offReady()
    }
    // conversations/voice/user намеренно НЕ в зависимостях: они читаются
    // через ref'ы выше. Иначе каждое входящее ЛС (setConversations) снимало и
    // заново вешало все обработчики этого эффекта — см. комментарий у
    // conversationsRef. Подавления exhaustive-deps здесь не нужно: после
    // перевода на ref'ы список зависимостей стал полным (линтер это
    // подтверждает).
  }, [gateway, channelId, serverId, activeConversationId])

  const openProfilePopup = useCallback((popupUser: ProfilePopupUser, e: ReactMouseEvent) => {
    e.stopPropagation()
    setProfilePopup({ user: popupUser, x: e.clientX, y: e.clientY })
  }, [])

  // --- контекстное меню участника голосового канала -----------------------
  // Открывается для ЛЮБОГО голосового канала/звонка, даже если мы сами сейчас
  // не подключены к нему вообще — какие пункты внутри доступны, решает уже
  // сам рендер ParticipantContextMenu ниже (см. voiceActionsEnabled).
  const openParticipantContextMenu = useCallback(
    (
      member: ParticipantContextMenuMember,
      e: ReactMouseEvent,
      room: { kind: 'channel' | 'conversation'; id: number | string },
    ) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenuTarget({ member, x: e.clientX, y: e.clientY, room })
    },
    [],
  )

  // «Упомянуть» — для канала сервера переключаемся на текущий выбранный
  // текстовый канал (или на первый текстовый) и подставляем "@Имя " в поле
  // ввода; для звонка в личке/группе подставляем в поле ввода ЭТОГО диалога.
  const handleMention = useCallback(
    (
      member: ParticipantContextMenuMember,
      room: { kind: 'channel' | 'conversation'; id: number | string },
    ) => {
      setContextMenuTarget(null)
      if (room.kind === 'conversation') {
        setServerId(null)
        setActiveConversationId(room.id as number)
        setMentionPrefill({ token: Date.now(), text: `@${member.username} ` })
        return
      }
      const target =
        currentChannel && currentChannel.kind === 'text'
          ? currentChannel
          : channels.find((c) => c.kind === 'text')
      if (!target) return
      setChannelId(target.id)
      setMentionPrefill({ token: Date.now(), text: `@${member.username} ` })
    },
    [channels, currentChannel],
  )

  const handleDisconnectUser = useCallback(
    (userId: number) => {
      gateway.voiceDisconnectUser(userId)
    },
    [gateway],
  )

  const handleStartMuteVote = useCallback(
    (userId: number) => {
      // Контекстное меню открывается только для полностью подключённых
      // (см. ChannelSidebar/VoiceStage), но перепроверяем на случай, если
      // соединение отвалилось прямо между открытием меню и кликом.
      if (voiceStatus !== 'connected') return
      gateway.voiceMuteVoteStart(userId)
    },
    [gateway, voiceStatus],
  )

  const handleCastMuteVote = useCallback(
    (forMute: boolean) => {
      gateway.voiceMuteVoteCast(forMute)
      setMuteVote(null)
    },
    [gateway],
  )

  const handleRequestScreenShare = useCallback(
    (userId: number) => {
      if (voiceStatus !== 'connected') return
      gateway.voiceRequestScreenShare(userId)
    },
    [gateway, voiceStatus],
  )

  const handleCreateServer = async () => {
    const name = window.prompt('Название сервера:')?.trim()
    if (!name) return
    const s = await api.createServer(name)
    setServers((prev) => [...prev, s])
    selectServer(s)
  }

  const handleJoined = (s: Server) => {
    setServers((prev) =>
      prev.some((x) => x.id === s.id) ? prev : [...prev, s],
    )
    selectServer(s)
    setShowDiscover(false)
  }

  // Сохранение из редактора сервера — ответ PATCH уже содержит свежий сервер
  // со всеми полями и правами, остальным он уедет через server_update.
  const handleServerUpdated = useCallback((updated: Server) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }, [])

  // --- уведомления/мьют/приватность/приглашения/выход сервера -------------
  const handleSelectChannel = useCallback((c: Channel) => {
    setChannelId(c.id)
    setUnreadChannelIds((prev) => {
      if (!prev.has(c.id)) return prev
      const next = new Set(prev)
      next.delete(c.id)
      return next
    })
  }, [])

  const handleMarkServerRead = useCallback((s: Server) => {
    const ids = new Set(s.channels.map((c) => c.id))
    setUnreadChannelIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of ids) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
  }, [])

  // Оптимистичный патч my_settings конкретного сервера — используется и для
  // мгновенного отклика на клик (до ответа сервера), и чтобы применить сам
  // ответ (полный актуальный payload с сервера).
  const patchServerSettings = useCallback(
    (serverIdValue: number, patch: Partial<ServerMemberSettings>) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverIdValue
            ? { ...s, my_settings: { ...s.my_settings, ...patch } }
            : s,
        ),
      )
    },
    [],
  )

  const handleMuteServer = useCallback(
    async (s: Server, minutes: number | 'forever') => {
      patchServerSettings(s.id, {
        muted: true,
        muted_forever: minutes === 'forever',
        muted_until: minutes === 'forever' ? null : s.my_settings.muted_until,
      })
      try {
        const updated = await api.updateServerSettings(
          s.id,
          minutes === 'forever' ? { mute_forever: true } : { mute_minutes: minutes },
        )
        patchServerSettings(s.id, updated)
      } catch (e) {
        alert('Не удалось заглушить сервер: ' + (e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleUnmuteServer = useCallback(
    async (s: Server) => {
      patchServerSettings(s.id, { muted: false, muted_forever: false, muted_until: null })
      try {
        const updated = await api.updateServerSettings(s.id, { unmute: true })
        patchServerSettings(s.id, updated)
      } catch (e) {
        alert('Не удалось снять заглушение: ' + (e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleSetNotificationLevel = useCallback(
    async (s: Server, level: NotificationLevel) => {
      patchServerSettings(s.id, { notification_level: level })
      try {
        await api.updateServerSettings(s.id, { notification_level: level })
      } catch (e) {
        alert('Не удалось изменить параметры уведомлений: ' + (e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleToggleIgnoreAtHere = useCallback(
    async (s: Server, value: boolean) => {
      patchServerSettings(s.id, { ignore_at_here: value })
      try {
        await api.updateServerSettings(s.id, { ignore_at_here: value })
      } catch (e) {
        alert((e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleToggleSuppressRoleMentions = useCallback(
    async (s: Server, value: boolean) => {
      patchServerSettings(s.id, { suppress_role_mentions: value })
      try {
        await api.updateServerSettings(s.id, { suppress_role_mentions: value })
      } catch (e) {
        alert((e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleLeaveServer = useCallback(
    async (s: Server) => {
      if (!window.confirm(`Покинуть сервер «${s.name}»?`)) return
      try {
        await api.leaveServer(s.id)
        setServers((prev) => prev.filter((x) => x.id !== s.id))
        if (serverId === s.id) {
          setServerId(null)
          setChannelId(null)
        }
      } catch (e) {
        alert('Не удалось покинуть сервер: ' + (e as Error).message)
      }
    },
    [serverId],
  )

  // Приглашение теперь карточка прямо в сообщении диалога (см.
  // ServerInviteCard/MessageList) — статус на ней обновится сам, живым
  // dm_message_update от бэкенда (см. chat.views._broadcast_invite_message_update),
  // отдельно патчить локальное состояние не нужно.
  const handleAcceptServerInvite = useCallback(async (inviteId: number) => {
    try {
      const server = await api.acceptServerInvite(inviteId)
      setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]))
      selectServer(server)
    } catch (e) {
      alert((e as Error).message)
    }
  }, [selectServer])

  const handleDeclineServerInvite = useCallback(async (inviteId: number) => {
    try {
      await api.declineServerInvite(inviteId)
    } catch (e) {
      alert((e as Error).message)
    }
  }, [])

  const handleOpenInvitedServer = useCallback((targetServerId: number) => {
    const server = servers.find((s) => s.id === targetServerId)
    if (server) selectServer(server)
  }, [servers, selectServer])

  const handleCreateChannel = async (kind: 'text' | 'voice') => {
    if (serverId == null) return
    const name = window.prompt(
      kind === 'text' ? 'Имя текстового канала:' : 'Имя голосового канала:',
    )?.trim()
    if (!name) return
    const ch = await api.createChannel(serverId, name, kind)
    setServers((prev) =>
      prev.map((s) =>
        s.id === serverId ? { ...s, channels: [...s.channels, ch] } : s,
      ),
    )
  }

  // Отправка идёт не напрямую в сокет, а через очередь: та рисует сообщение
  // сразу, ждёт подтверждения, при молчании повторяет, а окончательно
  // провалившееся кладёт в черновики (см. outbox.ts).
  const handleSend = (message: OutgoingMessage) => {
    if (channelId == null) return
    outbox.enqueue({
      target: { kind: 'channel', id: channelId },
      content: message.content,
      replyTo: replyTarget?.id ?? null,
      attachments: message.attachments,
    })
    setReplyTarget(null)
  }

  // Реакции переключаются по факту «стоит ли она уже у меня» — его считает
  // MessageList из user_ids, отдельно этот флаг нигде не хранится.
  const handleToggleReaction = useCallback(
    (messageId: number, emoji: string, mine: boolean) => {
      if (mine) gateway.removeReaction(messageId, emoji)
      else gateway.addReaction(messageId, emoji)
    },
    [gateway],
  )

  const handleToggleDmReaction = useCallback(
    (messageId: number, emoji: string, mine: boolean) => {
      if (mine) gateway.dmRemoveReaction(messageId, emoji)
      else gateway.dmAddReaction(messageId, emoji)
    },
    [gateway],
  )

  const handleDeleteMessage = (messageId: number) => {
    gateway.deleteMessage(messageId)
  }

  const handleReplyRequest = (m: ChatMessageBase) => {
    setEditTarget(null)
    setReplyTarget(m)
  }

  const handleEditRequest = (m: ChatMessageBase) => {
    setReplyTarget(null)
    setEditTarget(m)
  }

  const handleSaveEdit = (messageId: number, content: string) => {
    gateway.editMessage(messageId, content)
    setEditTarget(null)
  }

  const handleJoinVoice = async (ch: Channel) => {
    try {
      const { sfu_url, sfu_token } = await api.voiceCredentials(ch.id)
      setVoiceStatus('connecting')
      // gateway.voiceJoin — это «мета» голоса (presence/roster/call-state) в
      // Django; медиа идёт отдельно через SFU по sfu_url/sfu_token. Честный
      // статус ('connecting'/'failed') считается по факту подключения
      // WebRTC-транспорта к SFU внутри VoiceProvider (onStatus).
      gateway.voiceJoin(ch.id)
      setVoice({ room: { id: ch.id, name: ch.name, kind: 'channel' }, sfuUrl: sfu_url, sfuToken: sfu_token })
      // Клик по голосовому каналу — это и вход в него, и выбор того, что
      // показывать в main (как и для текстовых каналов): переключаем main
      // на VoiceStage этого канала.
      setChannelId(ch.id)
    } catch (e) {
      alert('Не удалось подключиться к голосу: ' + (e as Error).message)
    }
  }

  const handleLeaveVoice = useCallback(() => {
    // Себе самому звук выхода не прилетит через ростер (isChannelVoice/voice
    // уже станут false к моменту, когда эффект ниже увидит изменение members),
    // поэтому играем его явно здесь, в момент собственного выхода.
    playLeaveSound()
    gateway.voiceLeave()
    setVoice(null)
    // Ростер звонка в личке/группе — чисто клиентский стейт, который никто не
    // чистит при выходе: dm_voice_state_update про чужие выходы после нашего
    // уже не придёт (мы вышли из комнаты), а dm_voice_peers при следующем
    // входе только ДОБАВЛЯЕТ пиров к прежнему объекту. Без сброса следующий
    // звонок открывался со всеми, кто был в комнате на момент нашего выхода.
    setDmCallParticipants({})
  }, [gateway])

  // Единая точка входа для просмотра демонстрации экрана — используется и
  // кликом по бейджу «демка» в сайдбаре (для ЛЮБОГО голосового канала на
  // сервере), и кликом по превью внутри VoiceStage (для текущего канала).
  // Переключает main на нужный канал, при необходимости подключается к
  // голосу (как обычный клик по каналу), а сам просмотр запускает VoiceStage
  // через pendingWatch, как только демонстрация станет доступна в SFU.
  const handleWatchScreen = useCallback(
    (userId: number, targetChannelId: number) => {
      const channel = channels.find((c) => c.id === targetChannelId)
      if (!channel) return
      setChannelId(channel.id)
      if (voice?.room.kind !== 'channel' || voice.room.id !== channel.id) {
        void handleJoinVoice(channel)
      }
      setPendingWatch({ channelId: channel.id, userId })
    },
    [channels, voice],
  )

  const handleWatchBadge = useCallback(
    (member: Member) => {
      if (!member.voice_channel) return
      handleWatchScreen(member.id, Number(member.voice_channel))
    },
    [handleWatchScreen],
  )

  // --- домашний экран: диалоги/группы, друзья, звонки --------------------
  const handleOpenHome = useCallback(() => {
    setServerId(null)
    setChannelId(null)
  }, [])

  const handleSelectConversation = useCallback((c: Conversation) => {
    setActiveConversationId(c.id)
    setUnreadConversationIds((prev) => {
      if (!prev.has(c.id)) return prev
      const next = new Set(prev)
      next.delete(c.id)
      return next
    })
  }, [])

  const handleCreateConversation = async (data: {
    kind: 'dm' | 'group'
    userIds: number[]
    name: string
  }) => {
    try {
      const conv = await api.createConversation({
        kind: data.kind, user_ids: data.userIds, name: data.name,
      })
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]))
      setActiveConversationId(conv.id)
      setShowNewConversation(false)
    } catch (e) {
      alert('Не удалось создать диалог: ' + (e as Error).message)
    }
  }

  const handleSendDm = (message: OutgoingMessage) => {
    if (activeConversationId == null) return
    outbox.enqueue({
      target: { kind: 'conversation', id: activeConversationId },
      content: message.content,
      replyTo: dmReplyTarget?.id ?? null,
      attachments: message.attachments,
    })
    setDmReplyTarget(null)
  }

  const handleDeleteDmMessage = (messageId: number) => {
    gateway.dmDeleteMessage(messageId)
  }

  const handleDmReplyRequest = (m: ChatMessageBase) => {
    setDmEditTarget(null)
    setDmReplyTarget(m)
  }

  const handleDmEditRequest = (m: ChatMessageBase) => {
    setDmReplyTarget(null)
    setDmEditTarget(m)
  }

  const handleSaveDmEdit = (messageId: number, content: string) => {
    gateway.dmEditMessage(messageId, content)
    setDmEditTarget(null)
  }

  const handleDmVoiceJoin = useCallback(
    async (conversationId: number) => {
      try {
        const { sfu_url, sfu_token } = await api.conversationVoiceCredentials(conversationId)
        const conv = conversations.find((c) => c.id === conversationId)
        setVoiceStatus('connecting')
        // Начинаем звонок с пустого ростера: настоящий состав приедет в
        // dm_voice_peers сразу после входа (см. handleLeaveVoice — там же
        // про то, почему на один сброс при выходе полагаться нельзя).
        setDmCallParticipants({})
        gateway.dmVoiceJoin(conversationId)
        setVoice({
          room: {
            id: conversationId,
            name: conv ? conversationDisplayName(conv) : 'Звонок',
            kind: 'conversation',
          },
          sfuUrl: sfu_url,
          sfuToken: sfu_token,
        })
      } catch (e) {
        alert('Не удалось подключиться к звонку: ' + (e as Error).message)
      }
    },
    [gateway, conversations],
  )

  const handleAcceptIncomingCall = useCallback(() => {
    if (!incomingCall) return
    setServerId(null)
    setActiveConversationId(incomingCall.conversationId)
    void handleDmVoiceJoin(incomingCall.conversationId)
    setIncomingCall(null)
  }, [incomingCall, handleDmVoiceJoin])

  const handleDeclineIncomingCall = useCallback(() => {
    setIncomingCall(null)
  }, [])

  // Аналог handleWatchScreen, но для звонка в диалоге/группе — раз VoiceStage
  // тут показывается только пока мы УЖЕ в звонке (см. isInDmCall), не нужно
  // ни выбирать канал, ни авто-подключаться, только попросить показ.
  const handleDmRequestWatch = useCallback((userId: number) => {
    setDmPendingWatchUserId(userId)
  }, [])

  // Тянем нижнюю границу VoiceStage над текстовым чатом в открытом диалоге/
  // группе — тот же приём, что и везде в проекте для ресайза (глобальные
  // mousemove/mouseup на document, снимаются в конце драга).
  const dmResizeStartRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const handleDmVoiceStageResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      dmResizeStartRef.current = { startY: e.clientY, startHeight: dmVoiceStageHeight }
      const onMove = (ev: MouseEvent) => {
        const drag = dmResizeStartRef.current
        if (!drag) return
        const next = drag.startHeight + (ev.clientY - drag.startY)
        setDmVoiceStageHeight(Math.max(180, Math.min(next, window.innerHeight - 240)))
      }
      const onUp = () => {
        dmResizeStartRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [dmVoiceStageHeight],
  )

  // Незамеченный звонок сам перестаёт "звонить" — некому его отклонить,
  // если человек просто не смотрит в экран (нет push-уведомлений вне вкладки).
  useEffect(() => {
    if (!incomingCall) return
    const t = setTimeout(() => setIncomingCall(null), 30000)
    return () => clearTimeout(t)
  }, [incomingCall])

  const handleSendFriendRequest = async (username: string) => {
    try {
      await api.sendFriendRequest({ username })
      setFriends(await api.friends())
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleAcceptFriendRequest = async (requestId: number) => {
    try {
      await api.acceptFriendRequest(requestId)
      setFriends(await api.friends())
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleDeclineFriendRequest = async (requestId: number) => {
    try {
      await api.declineFriendRequest(requestId)
      setFriends((prev) => ({
        ...prev,
        incoming: prev.incoming.filter((r) => r.id !== requestId),
        outgoing: prev.outgoing.filter((r) => r.id !== requestId),
      }))
    } catch (e) {
      alert((e as Error).message)
    }
  }

  // "Добавить в друзья"/"Написать сообщение" из мини-профиля (клик по чужому
  // аватару/нику где угодно — см. MiniProfilePopup). Возвращает успех, чтобы
  // сам попап показал отклик на кнопке (галочка/«Отправлено») — раньше клик
  // никак не подтверждался визуально.
  const handleMiniProfileAddFriend = async (userId: number): Promise<boolean> => {
    try {
      await api.sendFriendRequest({ userId })
      setFriends(await api.friends())
      return true
    } catch (e) {
      alert((e as Error).message)
      return false
    }
  }

  const handleMiniProfileSendMessage = async (userId: number, content: string) => {
    try {
      const conv = await api.createConversation({ kind: 'dm', user_ids: [userId] })
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]))
      setServerId(null)
      setActiveConversationId(conv.id)
      // Через ту же очередь, что и обычная отправка: сообщение из мини-профиля
      // ничем не отличается и должно так же ретраиться и попадать в черновики.
      outbox.enqueue({
        target: { kind: 'conversation', id: conv.id },
        content,
      })
      setProfilePopup(null)
    } catch (e) {
      alert('Не удалось отправить сообщение: ' + (e as Error).message)
    }
  }

  // Реальный статус mesh-соединения (не оптимистичный).
  const handleVoiceStatus = useCallback(
    (status: VoiceStatus) => {
      setVoiceStatus(status)
      if (status !== 'failed') return
      const current = voiceRef.current
      if (!current) return
      gateway.voiceLeave()
      setVoice(null)
      // 'failed' сюда долетает только с самого первого коннекта (ни разу не
      // подключились) — если связь обрывается ПОСЛЕ успешного коннекта,
      // voice.ts бесконечно восстанавливается сам, без алертов и выкидывания
      // из канала (см. handleDropped в voice.ts).
      alert(
        `Не удалось подключиться к голосовому каналу «${current.room.name}». ` +
          'Проверь интернет-соединение (возможна блокировка WebRTC/UDP на твоей сети/VPN) и попробуй зайти снова.',
      )
    },
    [gateway],
  )

  // Если подключение зависло дольше 15с — считаем его неудавшимся.
  useEffect(() => {
    if (!voice || voiceStatus !== 'connecting') return
    const t = setTimeout(() => handleVoiceStatus('failed'), 15000)
    return () => clearTimeout(t)
  }, [voice, voiceStatus, handleVoiceStatus])

  // Заголовок вкладки — имя голосового канала, в котором мы сейчас сидим
  // (как в Discord), иначе просто название приложения.
  useEffect(() => {
    document.title = voice ? `${voice.room.name} - ${APP_NAME}` : APP_NAME
  }, [voice])

  // Пока мы в голосе — браузер спрашивает подтверждение на закрытие вкладки/
  // перезагрузку. Закрыть страницу случайно, сидя в звонке, слишком легко, а
  // выход из голоса необратим: переподключение — это новый вход в канал со
  // звуком для всех. Текст диалога задаёт сам браузер (свой показать нельзя —
  // спецификация это запрещает), от нас нужен только preventDefault.
  useEffect(() => {
    if (!voice) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Старые браузеры смотрят на returnValue, а не на preventDefault.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [voice])

  // Ростер участников ТЕКУЩЕГО голосового канала СЕРВЕРА — с чистого листа
  // при каждом входе/выходе, чтобы не проигрывать "звук входа" для всех, кто
  // уже был в канале до нас. Диалоги/группы сюда не попадают — их участники
  // не сидят в `members` вообще (это ростер СЕРВЕРА), см. dmCallParticipants
  // и отдельный звуковой эффект ниже.
  const voiceRosterRef = useRef<Set<number>>(new Set())
  const isChannelVoice = voice?.room.kind === 'channel'
  useEffect(() => {
    voiceRosterRef.current = isChannelVoice
      ? new Set(
          members
            .filter((m) => m.voice_channel === String(voice!.room.id))
            .map((m) => m.id),
        )
      : new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChannelVoice, voice?.room.id])

  // Звук при входе/выходе участников звонка, в котором мы сейчас сами —
  // играет для ВСЕХ в канале, включая самого вошедшего/вышедшего (каждый
  // клиент детектит смену ростера у себя локально и проигрывает звук сам).
  useEffect(() => {
    if (!isChannelVoice || !user) return
    const currentIds = new Set(
      members
        .filter((m) => m.voice_channel === String(voice!.room.id))
        .map((m) => m.id),
    )
    const prevIds = voiceRosterRef.current
    for (const id of currentIds) {
      if (!prevIds.has(id)) playJoinSound()
    }
    for (const id of prevIds) {
      if (!currentIds.has(id)) playLeaveSound()
    }
    voiceRosterRef.current = currentIds
  }, [members, voice, isChannelVoice, user])

  // Тот же звук входа/выхода, но для звонка в диалоге/группе — ростер там
  // приходит через dm_voice_state_update/dm_voice_peers прямо в
  // dmCallParticipants (см. gateway-эффект выше), не через members.
  const dmVoiceRosterRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!user) return
    const currentIds = new Set(Object.keys(dmCallParticipants).map(Number))
    const prevIds = dmVoiceRosterRef.current
    for (const id of currentIds) {
      if (!prevIds.has(id)) playJoinSound()
    }
    for (const id of prevIds) {
      if (!currentIds.has(id)) playLeaveSound()
    }
    dmVoiceRosterRef.current = currentIds
  }, [dmCallParticipants, user])

  // Тот же паттерн, что и звук входа/выхода: у кого из участников ТЕКУЩЕГО
  // канала флаг sharing_screen сменился — играем звук старта/стопа демонстрации,
  // тоже всем в канале, включая самого включившего/выключившего показ.
  const voiceSharingRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    voiceSharingRef.current = isChannelVoice
      ? new Set(
          members
            .filter((m) => m.voice_channel === String(voice!.room.id) && m.sharing_screen)
            .map((m) => m.id),
        )
      : new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChannelVoice, voice?.room.id])

  useEffect(() => {
    if (!isChannelVoice || !user) return
    const currentSharing = new Set(
      members
        .filter((m) => m.voice_channel === String(voice!.room.id) && m.sharing_screen)
        .map((m) => m.id),
    )
    const prevSharing = voiceSharingRef.current
    for (const id of currentSharing) {
      if (!prevSharing.has(id)) playScreenShareStartSound()
    }
    for (const id of prevSharing) {
      if (!currentSharing.has(id)) playScreenShareStopSound()
    }
    voiceSharingRef.current = currentSharing
  }, [members, voice, isChannelVoice, user])

  return (
    <VoiceProvider voice={voice} onStatus={handleVoiceStatus}>
    {/* screen-* всегда в className, не только при isMobile: сама раскладка
        (nav vs content, слайд) целиком на CSS-медиа-запросе в index.css —
        реальная ширина вьюпорта решает, применится ли она вообще. Если
        завязать это ЕЩЁ и на JS isMobile (matchMedia), два источника
        истины могут разойтись (гонка при первом рендере и т.п.) — тогда
        класса не будет вовсе, и мобильный layout целиком откатится на
        десктопную grid-сетку, где main обязательно виден рядом с
        сайдбаром. isMobile ниже используется только для вещей, которые
        JS ДОЛЖЕН явно знать (кнопка назад, история браузера). */}
    <div className={`app screen-${mobileScreen}`}>
      {/* Единая "nav-панель" — рельса+сайдбар каналов вместе, всегда
          настоящий flex-контейнер (см. .mobile-nav-pane в index.css; на ПК
          это первая 312px-колонка общей grid, на мобилке — nav-экран на
          весь экран, скрывается целиком при переходе в content). */}
      <div className="mobile-nav-pane">
      <ServerRail
        servers={servers}
        activeId={serverId}
        onSelect={selectServer}
        onCreate={handleCreateServer}
        onDiscover={() => setShowDiscover(true)}
        onHome={handleOpenHome}
        homeNotificationCount={
          friends.incoming.length + unreadConversationIds.size
        }
        unreadServerIds={unreadServerIds}
        mutedServerIds={mutedServerIds}
        onContextMenu={(s, e) => setServerContextMenuServerId({ id: s.id, x: e.clientX, y: e.clientY })}
      />

      {serverId == null ? (
        <HomeSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={(c) => {
            handleSelectConversation(c)
            navigateToContent()
          }}
          friends={friends}
          onOpenNewConversation={() => setShowNewConversation(true)}
          onSendFriendRequest={handleSendFriendRequest}
          onAcceptFriendRequest={handleAcceptFriendRequest}
          onDeclineFriendRequest={handleDeclineFriendRequest}
          voice={voice}
          voiceRoster={voiceRoster}
          voiceTopic={voiceTopic}
          voiceStatus={voiceStatus}
          user={user!}
          onLeaveVoice={handleLeaveVoice}
          onOpenSettings={openMobileSettings}
          onOpenProfile={() => setShowProfile(true)}
          onOpenUserProfile={openProfilePopup}
        />
      ) : (
        <ChannelSidebar
          server={currentServer}
          channels={channels}
          activeChannelId={channelId}
          members={members}
          voice={voice}
          voiceRoster={voiceRoster}
          voiceTopic={voiceTopic}
          voiceStatus={voiceStatus}
          user={user!}
          onSelectText={(c) => {
            handleSelectChannel(c)
            navigateToContent()
          }}
          onJoinVoice={(c) => {
            handleJoinVoice(c)
            navigateToContent()
          }}
          onLeaveVoice={handleLeaveVoice}
          onCreateChannel={handleCreateChannel}
          onOpenSettings={openMobileSettings}
          onOpenProfile={() => setShowProfile(true)}
          onWatchScreen={handleWatchBadge}
          onOpenServerSettings={() => setShowServerSettings(true)}
          onParticipantContextMenu={openParticipantContextMenu}
          onOpenParticipantProfile={openProfilePopup}
        />
      )}
      </div>

      <main className={`chat ${currentChannel?.kind === 'voice' ? 'chat-voice' : ''}`}>
        {serverId == null ? (
          activeConversation ? (
            <>
              <header className="chat-header">
                {isMobile && (
                  <button className="chat-back-btn" title="Назад к списку" onClick={goBackMobile}>
                    <ChevronLeft size={20} />
                  </button>
                )}
                <span className="hash">@</span>
                <span className="chat-header-name">{conversationDisplayName(activeConversation)}</span>
                {voice?.room.kind === 'conversation' && voice.room.id === activeConversation.id ? (
                  <button className="icon-btn dm-call-leave" title="Завершить звонок" onClick={handleLeaveVoice}>
                    <PhoneOff size={16} />
                  </button>
                ) : (
                  <button
                    className="icon-btn"
                    title="Позвонить"
                    onClick={() => handleDmVoiceJoin(activeConversation.id)}
                  >
                    <Phone size={16} />
                  </button>
                )}
              </header>
              {isInDmCall && (
                <div className="dm-voicestage-wrap" style={{ height: dmVoiceStageHeight }}>
                  <VoiceStage
                    key={activeConversation.id}
                    roomId={activeConversation.id}
                    roomName={conversationDisplayName(activeConversation)}
                    roster={dmRoster}
                    selfUserId={user!.id}
                    pendingWatchUserId={dmPendingWatchUserId}
                    onConsumedPendingWatch={() => setDmPendingWatchUserId(null)}
                    onRequestWatch={handleDmRequestWatch}
                    onOpenProfile={openProfilePopup}
                    onParticipantContextMenu={openParticipantContextMenu}
                    roomKind="conversation"
                    // Этот VoiceStage рендерится только пока isInDmCall — то
                    // есть мы всегда уже подключены, VoiceLanding здесь не
                    // нужен (для звонка в личке/группе нет отдельного "canала"
                    // без входа, только сам звонок).
                    isConnected
                    onJoin={() => handleDmVoiceJoin(activeConversation.id)}
                    onLeave={handleLeaveVoice}
                  />
                  <div
                    className="dm-voicestage-resize"
                    onMouseDown={handleDmVoiceStageResizeStart}
                    title="Потянуть, чтобы изменить размер"
                  />
                </div>
              )}
              <MessageList
                // Неотправленные дописываются в конец ленты: у них ещё нет id
                // на сервере, но человек должен видеть, что он написал.
                messages={[
                  ...dmMessages,
                  ...pendingDmMessages.map((p) => pendingAsMessage(p, user!)),
                ]}
                currentUserId={user!.id}
                canModerate={false}
                editingId={dmEditTarget?.id ?? null}
                onDelete={handleDeleteDmMessage}
                onEditRequest={handleDmEditRequest}
                onReply={handleDmReplyRequest}
                onOpenProfile={openProfilePopup}
                onToggleReaction={handleToggleDmReaction}
                onRetry={(nonce) => outbox.retry(nonce)}
                onDiscard={(nonce) => outbox.discard(nonce)}
                onAcceptServerInvite={handleAcceptServerInvite}
                onDeclineServerInvite={handleDeclineServerInvite}
                onOpenInvitedServer={handleOpenInvitedServer}
              />
              <MessageInput
                channelName={conversationDisplayName(activeConversation)}
                hash={false}
                onSend={handleSendDm}
                replyTarget={dmReplyTarget}
                onCancelReply={() => setDmReplyTarget(null)}
                editTarget={dmEditTarget}
                onSaveEdit={handleSaveDmEdit}
                onCancelEdit={() => setDmEditTarget(null)}
                prefill={mentionPrefill}
              />
            </>
          ) : (
            <div className="chat-empty">Выбери диалог слева или начни новый</div>
          )
        ) : currentChannel && currentChannel.kind === 'voice' ? (
          <VoiceStage
            key={currentChannel.id}
            roomId={currentChannel.id}
            roomName={currentChannel.name}
            roster={members.filter((m) => m.voice_channel === String(currentChannel.id))}
            selfUserId={user!.id}
            pendingWatchUserId={
              pendingWatch?.channelId === currentChannel.id ? pendingWatch.userId : null
            }
            onConsumedPendingWatch={() => setPendingWatch(null)}
            onRequestWatch={(userId) => handleWatchScreen(userId, currentChannel.id)}
            onOpenProfile={openProfilePopup}
            onParticipantContextMenu={openParticipantContextMenu}
            roomKind="channel"
            isConnected={voice?.room.kind === 'channel' && voice.room.id === currentChannel.id}
            onJoin={() => handleJoinVoice(currentChannel)}
            onLeave={handleLeaveVoice}
            isMobile={isMobile}
            onBack={goBackMobile}
          />
        ) : currentChannel && currentChannel.kind === 'text' ? (
          <>
            <header className="chat-header">
              {isMobile && (
                <button className="chat-back-btn" title="Назад к списку" onClick={goBackMobile}>
                  <ChevronLeft size={20} />
                </button>
              )}
              <span className="hash">#</span>
              <span className="chat-header-name">{currentChannel.name}</span>
              <button
                type="button"
                className={`chat-header-members-toggle ${showMembersList ? 'active' : ''}`}
                title={showMembersList ? 'Скрыть список участников' : 'Показать список участников'}
                onClick={() => setShowMembersList((v) => !v)}
              >
                <Users size={18} />
              </button>
            </header>
            <MessageList
              messages={[
                ...messages,
                ...pendingChannelMessages.map((p) => pendingAsMessage(p, user!)),
              ]}
              currentUserId={user!.id}
              canModerate={canDeleteMessages}
              editingId={editTarget?.id ?? null}
              onDelete={handleDeleteMessage}
              onEditRequest={handleEditRequest}
              onReply={handleReplyRequest}
              onOpenProfile={openProfilePopup}
              onToggleReaction={handleToggleReaction}
              onRetry={(nonce) => outbox.retry(nonce)}
              onDiscard={(nonce) => outbox.discard(nonce)}
            />
            <MessageInput
              channelName={currentChannel.name}
              onSend={handleSend}
              replyTarget={replyTarget}
              onCancelReply={() => setReplyTarget(null)}
              editTarget={editTarget}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={() => setEditTarget(null)}
              prefill={mentionPrefill}
            />
          </>
        ) : (
          <div className="chat-empty">
            {currentServer
              ? 'Выбери текстовый канал слева'
              : 'Создай сервер или зайди в существующий'}
          </div>
        )}
      </main>

      {/* Список участников — только для текстового канала (voice-канал и его
          заглушка "Присоединиться", DM/группа, пустой экран без выбранного
          канала — все прячут его, места справа под сетку/лендинг звонка не
          остаётся). showMembersList — ещё один тумблер поверх этого, из
          иконки в chat-header, действует только пока мы и так в тексте. */}
      {serverId != null && currentChannel?.kind === 'text' && showMembersList ? (
        <MembersList
          members={members}
          channels={channels}
          roles={rolesForServer(serverId)}
          ownerId={currentServer?.owner ?? -1}
          onOpenProfile={openProfilePopup}
        />
      ) : (
        <aside className="members-list" />
      )}

      {showNewConversation && (
        <NewConversationModal
          people={knownPeople}
          onClose={() => setShowNewConversation(false)}
          onCreate={(data) =>
            handleCreateConversation({ kind: data.kind, userIds: data.userIds, name: data.name })
          }
        />
      )}
      {incomingCall && (
        <IncomingCallBanner
          callerUsername={incomingCall.caller.username}
          callerAvatarColor={incomingCall.caller.avatar_color}
          callerAvatarImage={incomingCall.caller.avatar_image}
          conversationLabel={
            conversations.find((c) => c.id === incomingCall.conversationId)?.kind === 'group'
              ? conversationDisplayName(conversations.find((c) => c.id === incomingCall.conversationId)!)
              : incomingCall.caller.username
          }
          onAccept={handleAcceptIncomingCall}
          onDecline={handleDeclineIncomingCall}
        />
      )}

      {showDiscover && (
        <DiscoverModal
          onClose={() => setShowDiscover(false)}
          onJoined={handleJoined}
        />
      )}
      {showServerSettings && currentServer && (
        <ServerSettingsModal
          server={currentServer}
          members={members}
          onClose={() => setShowServerSettings(false)}
          onServerUpdated={handleServerUpdated}
          onMembersChanged={reloadMembers}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={closeSettings} onLogout={logout} isMobile={isMobile} />
      )}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {profilePopup && (
        <MiniProfilePopup
          target={profilePopup}
          currentUserId={user!.id}
          isFriend={friends.friends.some((f) => f.id === profilePopup.user.id)}
          onClose={() => setProfilePopup(null)}
          onAddFriend={handleMiniProfileAddFriend}
          onSendMessage={handleMiniProfileSendMessage}
        />
      )}
      {contextMenuTarget && (
        <ParticipantContextMenu
          target={contextMenuTarget}
          canManageMembers={
            contextMenuTarget.room.kind === 'channel' &&
            !!currentServer?.my_permissions?.manage_members
          }
          voteDisabled={
            activeMuteVoteChannelId != null &&
            voice?.room.kind === 'channel' &&
            voice.room.id === activeMuteVoteChannelId
          }
          // Голосование за мут / запрос демонстрации / блокировка зрителя
          // демонстрации требуют, чтобы мы сами были ПОЛНОСТЬЮ подключены
          // именно к комнате member'а из target — само меню открывается и
          // без этого (см. ChannelSidebar/VoiceStage), просто эти пункты
          // будут задизейблены.
          voiceActionsEnabled={
            voiceStatus === 'connected' &&
            !!voice &&
            voice.room.kind === contextMenuTarget.room.kind &&
            voice.room.id === contextMenuTarget.room.id
          }
          onClose={() => setContextMenuTarget(null)}
          onMention={(member) => handleMention(member, contextMenuTarget.room)}
          onDisconnect={handleDisconnectUser}
          onStartMuteVote={handleStartMuteVote}
          onRequestScreenShare={handleRequestScreenShare}
        />
      )}
      {muteVote && voice?.room.kind === 'channel' && voice.room.id === muteVote.channelId && (
        <MuteVoteModal
          vote={{
            channelId: muteVote.channelId,
            targetUserId: muteVote.targetUserId,
            targetUsername:
              members.find((m) => m.id === muteVote.targetUserId)?.username ??
              `Участник ${muteVote.targetUserId}`,
            endsAt: muteVote.endsAt,
          }}
          onCastVote={handleCastMuteVote}
        />
      )}
      {serverContextMenuServerId && (() => {
        const menuServer = servers.find((s) => s.id === serverContextMenuServerId.id)
        // Сервер мог исчезнуть из списка (вышли/выгнали) прямо пока меню
        // открыто — тогда просто не рендерим его вместо падения на undefined.
        if (!menuServer) return null
        return (
          <ServerContextMenu
            server={menuServer}
            x={serverContextMenuServerId.x}
            y={serverContextMenuServerId.y}
            canManageServer={
              !!menuServer.my_permissions &&
              (menuServer.my_permissions.manage_server ||
                menuServer.my_permissions.manage_roles ||
                menuServer.my_permissions.manage_members)
            }
            isOwner={menuServer.owner === user!.id}
            onClose={() => setServerContextMenuServerId(null)}
            onMarkRead={() => handleMarkServerRead(menuServer)}
            onInvite={() => setShowServerInviteId(menuServer.id)}
            onMute={(minutes) => handleMuteServer(menuServer, minutes)}
            onUnmute={() => handleUnmuteServer(menuServer)}
            onNotificationLevel={(level) => handleSetNotificationLevel(menuServer, level)}
            onToggleIgnoreAtHere={(v) => handleToggleIgnoreAtHere(menuServer, v)}
            onToggleSuppressRoleMentions={(v) => handleToggleSuppressRoleMentions(menuServer, v)}
            onOpenServerSettings={() => {
              selectServer(menuServer)
              setShowServerSettings(true)
            }}
            onOpenPrivacy={() => setShowServerPrivacyId(menuServer.id)}
            onLeave={() => handleLeaveServer(menuServer)}
          />
        )
      })()}
      {showServerInviteId != null && (() => {
        const inviteServer = servers.find((s) => s.id === showServerInviteId)
        if (!inviteServer) return null
        return (
          <ServerInviteModal
            server={inviteServer}
            people={knownPeople}
            onClose={() => setShowServerInviteId(null)}
          />
        )
      })()}
      {showServerPrivacyId != null && (() => {
        const privacyServer = servers.find((s) => s.id === showServerPrivacyId)
        if (!privacyServer) return null
        return (
          <ServerPrivacyModal
            server={privacyServer}
            onClose={() => setShowServerPrivacyId(null)}
            onSettingsUpdated={patchServerSettings}
          />
        )
      })()}
    </div>
    </VoiceProvider>
  )
}
