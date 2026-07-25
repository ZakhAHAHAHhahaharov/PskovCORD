import { useCallback, useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import {
  api, Channel, ChatMessageBase, Conversation, ConversationMessage, FriendsState, KnownPerson,
  Member, Message, Server,
} from '../api'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import {
  playJoinSound,
  playLeaveSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
} from '../sounds'
import ServerRail from './ServerRail'
import ChannelSidebar from './ChannelSidebar'
import HomeSidebar from './HomeSidebar'
import NewConversationModal from './NewConversationModal'
import IncomingCallBanner from './IncomingCallBanner'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import MembersList from './MembersList'
import VoiceProvider, { VoiceStatus } from './VoiceProvider'
import VoiceStage, { VoiceRosterMember } from './VoiceStage'
import DiscoverModal from './DiscoverModal'
import ServerSettingsModal from './ServerSettingsModal'
import SettingsModal from './SettingsModal'
import ProfileModal from './ProfileModal'
import MiniProfilePopup, { ProfilePopupTarget, ProfilePopupUser } from './MiniProfilePopup'

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

  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState<number | null>(null)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [voice, setVoice] = useState<VoiceState | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('connecting')
  const [showDiscover, setShowDiscover] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [profilePopup, setProfilePopup] = useState<ProfilePopupTarget | null>(null)
  const [replyTarget, setReplyTarget] = useState<ChatMessageBase | null>(null)
  const [editTarget, setEditTarget] = useState<ChatMessageBase | null>(null)

  // --- домашний экран: диалоги/группы, друзья, звонки в них -------------
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)
  const [dmMessages, setDmMessages] = useState<ConversationMessage[]>([])
  const [dmReplyTarget, setDmReplyTarget] = useState<ChatMessageBase | null>(null)
  const [dmEditTarget, setDmEditTarget] = useState<ChatMessageBase | null>(null)
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

  const currentServer = servers.find((s) => s.id === serverId) || null
  const channels = currentServer?.channels || []
  const currentChannel = channels.find((c) => c.id === channelId) || null
  // Модерация чата — по праву роли (владельцу chat/roles.py выдаёт всё).
  const canDeleteMessages = !!currentServer?.my_permissions?.delete_messages
  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null
  const dmRoster: VoiceRosterMember[] = Object.values(dmCallParticipants).map((p) => ({
    id: p.id, username: p.username, avatar_color: p.avatar_color, avatar_image: p.avatar_image,
    muted: p.muted, deafened: p.deafened, sharing_screen: p.sharing_screen,
  }))
  const isInDmCall =
    voice?.room.kind === 'conversation' && activeConversation != null && voice.room.id === activeConversation.id

  const selectServer = useCallback((s: Server) => {
    setServerId(s.id)
    const firstText = s.channels.find((c) => c.kind === 'text')
    setChannelId(firstText ? firstText.id : s.channels[0]?.id ?? null)
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

  // Диалоги/группы и друзья — не завязаны на выбранный сервер, нужны сразу
  // (бейдж входящих заявок, доступность домашнего экрана в любой момент).
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

  // Список людей для пикера «новый диалог/группа» — обновляем при каждом
  // открытии модалки (мог появиться новый общий сервер/друг с прошлого раза).
  useEffect(() => {
    if (!showNewConversation) return
    ;(async () => {
      try {
        setKnownPeople(await api.knownPeople())
      } catch {
        setKnownPeople([])
      }
    })()
  }, [showNewConversation])

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
      if (d.message.channel === channelId) {
        setMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
        )
      }
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
    // Смена ника/аватара — свою уже применили локально сразу после ответа
    // PATCH /api/auth/me (см. handleProfileUpdated), но остальным участникам
    // и старым сообщениям в списке нужно обновиться этим же событием.
    const offProfileUpdate = gateway.on('profile_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id
            ? { ...m, username: d.username, avatar_color: d.avatar_color, avatar_image: d.avatar_image }
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
    const offDmMsg = gateway.on('dm_message_create', (d) => {
      if (d.message.conversation === activeConversationId) {
        setDmMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
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
      if (voice?.room.kind !== 'conversation' || voice.room.id !== d.conversation_id) return
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
      if (voice?.room.kind !== 'conversation' || voice.room.id !== d.conversation_id) return
      const conv = conversations.find((c) => c.id === d.conversation_id)
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
      if (voice?.room.kind === 'conversation' && voice.room.id === d.conversation_id) return
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

    return () => {
      offMsg()
      offMsgDelete()
      offMsgUpdate()
      offPresence()
      offVoice()
      offMicStatus()
      offScreenShare()
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
    }
  }, [gateway, channelId, serverId, activeConversationId, conversations, voice])

  const openProfilePopup = useCallback((popupUser: ProfilePopupUser, e: ReactMouseEvent) => {
    e.stopPropagation()
    setProfilePopup({ user: popupUser, x: e.clientX, y: e.clientY })
  }, [])

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

  const handleSend = (content: string) => {
    if (channelId == null) return
    gateway.sendMessage(channelId, content, replyTarget?.id ?? null)
    setReplyTarget(null)
  }

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

  const handleSendDm = (content: string) => {
    if (activeConversationId == null) return
    gateway.dmSendMessage(activeConversationId, content, dmReplyTarget?.id ?? null)
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
  // аватару/нику где угодно — см. MiniProfilePopup).
  const handleMiniProfileAddFriend = async (userId: number) => {
    try {
      await api.sendFriendRequest({ userId })
      setFriends(await api.friends())
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleMiniProfileSendMessage = async (userId: number, content: string) => {
    try {
      const conv = await api.createConversation({ kind: 'dm', user_ids: [userId] })
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]))
      setServerId(null)
      setActiveConversationId(conv.id)
      gateway.dmSendMessage(conv.id, content)
      setProfilePopup(null)
    } catch (e) {
      alert('Не удалось отправить сообщение: ' + (e as Error).message)
    }
  }

  // Реальный статус mesh-соединения (не оптимистичный).
  const handleVoiceStatus = useCallback(
    (status: VoiceStatus) => {
      setVoiceStatus(status)
      if (status === 'failed') {
        setVoice((v) => {
          if (v) {
            gateway.voiceLeave()
            // 'failed' сюда долетает только с самого первого коннекта (ни разу
            // не подключились) — если связь обрывается ПОСЛЕ успешного коннекта,
            // voice.ts сам бесконечно пытается восстановиться сам, без алертов
            // и выкидывания из канала (см. handleDropped в voice.ts).
            alert(
              `Не удалось подключиться к голосовому каналу «${v.room.name}». ` +
                'Проверь интернет-соединение (возможна блокировка WebRTC/UDP на твоей сети/VPN) и попробуй зайти снова.',
            )
          }
          return null
        })
      }
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
    <div className="app">
      <ServerRail
        servers={servers}
        activeId={serverId}
        onSelect={selectServer}
        onCreate={handleCreateServer}
        onDiscover={() => setShowDiscover(true)}
        onHome={handleOpenHome}
      />

      {serverId == null ? (
        <HomeSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          friends={friends}
          onOpenNewConversation={() => setShowNewConversation(true)}
          onSendFriendRequest={handleSendFriendRequest}
          onAcceptFriendRequest={handleAcceptFriendRequest}
          onDeclineFriendRequest={handleDeclineFriendRequest}
          voice={voice}
          voiceStatus={voiceStatus}
          user={user!}
          onLeaveVoice={handleLeaveVoice}
          onOpenSettings={() => setShowSettings(true)}
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
          voiceStatus={voiceStatus}
          user={user!}
          onSelectText={(c) => setChannelId(c.id)}
          onJoinVoice={handleJoinVoice}
          onLeaveVoice={handleLeaveVoice}
          onCreateChannel={handleCreateChannel}
          onOpenSettings={() => setShowSettings(true)}
          onOpenProfile={() => setShowProfile(true)}
          onWatchScreen={handleWatchBadge}
          onOpenServerSettings={() => setShowServerSettings(true)}
        />
      )}

      <main className={`chat ${currentChannel?.kind === 'voice' ? 'chat-voice' : ''}`}>
        {serverId == null ? (
          activeConversation ? (
            <>
              <header className="chat-header">
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
                  />
                  <div
                    className="dm-voicestage-resize"
                    onMouseDown={handleDmVoiceStageResizeStart}
                    title="Потянуть, чтобы изменить размер"
                  />
                </div>
              )}
              <MessageList
                messages={dmMessages}
                currentUserId={user!.id}
                canModerate={false}
                editingId={dmEditTarget?.id ?? null}
                onDelete={handleDeleteDmMessage}
                onEditRequest={handleDmEditRequest}
                onReply={handleDmReplyRequest}
                onOpenProfile={openProfilePopup}
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
          />
        ) : currentChannel && currentChannel.kind === 'text' ? (
          <>
            <header className="chat-header">
              <span className="hash">#</span>
              <span className="chat-header-name">{currentChannel.name}</span>
            </header>
            <MessageList
              messages={messages}
              currentUserId={user!.id}
              canModerate={canDeleteMessages}
              editingId={editTarget?.id ?? null}
              onDelete={handleDeleteMessage}
              onEditRequest={handleEditRequest}
              onReply={handleReplyRequest}
              onOpenProfile={openProfilePopup}
            />
            <MessageInput
              channelName={currentChannel.name}
              onSend={handleSend}
              replyTarget={replyTarget}
              onCancelReply={() => setReplyTarget(null)}
              editTarget={editTarget}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={() => setEditTarget(null)}
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

      {serverId == null ? (
        <aside className="members-list" />
      ) : (
        <MembersList members={members} channels={channels} onOpenProfile={openProfilePopup} />
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
        <SettingsModal onClose={() => setShowSettings(false)} onLogout={logout} />
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
    </div>
    </VoiceProvider>
  )
}
