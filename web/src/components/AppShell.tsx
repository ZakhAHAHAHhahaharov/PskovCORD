import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronLeft, Phone, PhoneOff, Users } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useChannelMessages } from '../hooks/useChannelMessages'
import { useConversationsData } from '../hooks/useConversationsData'
import { useInviteLinks } from '../hooks/useInviteLinks'
import { useMobileNav } from '../hooks/useMobileNav'
import { useNameFonts } from '../hooks/useNameFonts'
import { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import { useServerData } from '../hooks/useServerData'
import { useVoiceCall } from '../hooks/useVoiceCall'
import {
  api, Channel, ChatMessageBase, Conversation, ConversationMessage, FriendsState, InvitePreview,
  KnownPerson, Member, Message, NameEffect, NotificationLevel, Role, Server, ServerMemberSettings,
} from '../api'
import { useAuth } from '../auth'
import { conversationDisplayName } from '../conversation'
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
  playWakeUpSound,
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
import ChannelContextMenu from './ChannelContextMenu'
import ChannelInviteModal from './ChannelInviteModal'
import VoiceInviteJoinModal from './VoiceInviteJoinModal'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

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
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
}

interface IncomingCall {
  conversationId: number
  caller: CallParticipant
}

export default function AppShell() {
  const { user, logout } = useAuth()
  const gateway = useGateway()
  // Прогревает каталог шрифтов ника (@font-face, см. useNameFonts) один раз
  // на всё приложение — до этого стиль ника с кастомным шрифтом в
  // сообщениях/войсе рисовался бы системным шрифтом, пока кто-нибудь не
  // откроет DisplayNameStyleModal (там тот же хук вызывается снова, но
  // промис уже общий и второго запроса не будет).
  useNameFonts()

  const isMobile = useIsMobile()
  const { mobileScreen, pushMobileLayer, goBackMobile, navigateToContent } = useMobileNav(isMobile)

  const userRef = useRef(user)
  userRef.current = user

  const serverData = useServerData(userRef)
  const {
    servers, setServers,
    serverId, setServerId,
    channelId, setChannelId,
    members, setMembers,
    serverRoles, setServerRoles,
    serverMembersCache, setServerMembersCache,
    fetchedServerDataIds, serversRef,
    unreadChannelIds, setUnreadChannelIds,
    showDiscover, setShowDiscover,
    showServerSettings, setShowServerSettings,
    serverContextMenuServerId, setServerContextMenuServerId,
    showServerInviteId, setShowServerInviteId,
    showServerPrivacyId, setShowServerPrivacyId,
    channelContextMenuId, setChannelContextMenuId,
    showChannelInviteId, setShowChannelInviteId,
    currentServer, channels, currentChannel,
    mutedServerIds, unreadServerIds,
    channelServerId, channelServerIdRef,
    membersForServer, rolesForServer,
    isServerMutedNow, shouldNotifyForChannel, shouldNotifyRef,
    selectServer, reloadMembers, reloadRoles,
    handleCreateServer, handleJoined, handleServerUpdated,
    handleSelectChannel, handleMarkServerRead, patchServerSettings,
    handleMuteServer, handleUnmuteServer, handleSetNotificationLevel,
    handleToggleIgnoreAtHere, handleToggleSuppressRoleMentions, handleLeaveServer,
    handleCreateChannel, handleTogglePinChannel, handleCopyChannelLink, handleSetChannelStatus,
  } = serverData
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
  // Черновики композера — по одному на канал/диалог, переживают переключение
  // между ними (и отлучку в голосовой канал/пустой экран): сам MessageInput
  // размонтируется при смене места (см. key={draftKey} у обоих <MessageInput>
  // ниже), поэтому текст живёт здесь, а не локальным стейтом компонента.
  const draftsRef = useRef<Map<string, string>>(new Map())
  const saveDraft = useCallback((key: string, text: string) => {
    if (text) draftsRef.current.set(key, text)
    else draftsRef.current.delete(key)
  }, [])
  const loadDraft = useCallback((key: string): string | undefined => {
    return draftsRef.current.get(key)
  }, [])
  // Незавершённое редактирование сообщения — как и черновик, привязано к
  // конкретному каналу/диалогу (тот же формат ключа: "channel-5"/"dm-12") и
  // должно вернуться, если уйти в другой канал/диалог и вернуться обратно, а
  // не просто закрыться. Сохраняется в cleanup-функциях эффектов ниже.
  const pendingEditsRef = useRef<Map<string, ChatMessageBase>>(new Map())

  // --- домашний экран: диалоги/группы, друзья, звонки в них -------------
  const conversationsData = useConversationsData(
    gateway, setServerId, showServerInviteId, () => setProfilePopup(null), pendingEditsRef,
  )
  const {
    conversations, setConversations, conversationsRef,
    activeConversationId, setActiveConversationId,
    dmMessages, setDmMessages, dmMessagesRef,
    dmReplyTarget, setDmReplyTarget,
    dmEditTarget, setDmEditTargetTracked,
    unreadConversationIds, setUnreadConversationIds,
    friends, setFriends,
    showNewConversation, setShowNewConversation,
    knownPeople,
    handleSelectConversation, handleCreateConversation,
    handleSendDm, handleDeleteDmMessage,
    handleDmReplyRequest, handleDmEditRequest, handleSaveDmEdit,
    handleSendFriendRequest, handleAcceptFriendRequest, handleDeclineFriendRequest,
    handleMiniProfileAddFriend, handleMiniProfileSendMessage,
  } = conversationsData
  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null

  const voiceCall = useVoiceCall(
    gateway, user, members, channels, conversations, activeConversation,
    setChannelId, setServerId, setActiveConversationId,
  )
  const {
    voice, setVoice, voiceRef,
    voiceStatus, setVoiceStatus,
    dmCallParticipants, setDmCallParticipants,
    incomingCall, setIncomingCall,
    dmPendingWatchUserId, setDmPendingWatchUserId,
    dmVoiceStageHeight,
    pendingWatch, setPendingWatch,
    activeMuteVoteChannelId, setActiveMuteVoteChannelId,
    muteVote, setMuteVote,
    dmRoster, isInDmCall, voiceRoster, voiceTopic,
    handleJoinVoice, handleLeaveVoice, handleDmVoiceJoin,
    handleAcceptIncomingCall, handleDeclineIncomingCall,
    handleWatchScreen, handleWatchBadge, handleDmRequestWatch,
    handleDmVoiceStageResizeStart, handleVoiceStatus,
    handleDisconnectUser, handleStartMuteVote, handleCastMuteVote,
    handleRequestScreenShare, handleWakeUser,
  } = voiceCall

  const participantContextMenu = useParticipantContextMenu(
    channels, currentChannel, setChannelId, setServerId, setActiveConversationId,
  )
  const {
    contextMenuTarget, setContextMenuTarget,
    mentionPrefill,
    openParticipantContextMenu, handleMention,
  } = participantContextMenu

  const channelMessages = useChannelMessages(currentChannel, channelId, gateway, pendingEditsRef)
  const {
    messages, setMessages, messagesRef,
    replyTarget, setReplyTarget,
    editTarget, setEditTargetTracked,
    handleSend, handleToggleReaction, handleDeleteMessage,
    handleReplyRequest, handleEditRequest, handleSaveEdit,
  } = channelMessages

  const inviteLinks = useInviteLinks(servers, setServers, selectServer, handleJoinVoice)
  const {
    voiceInvite, setVoiceInvite,
    handleAcceptServerInvite, handleDeclineServerInvite,
    handleOpenInvitedServer, handleConfirmVoiceInvite,
  } = inviteLinks

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
            // Стиль ника (см. nameStyle.ts) сюда не приезжает — так же, как и
            // роли ниже, уточнится следующим полным api.members(). До тех
            // пор ник рисуется как обычный текст, без стиля.
            name_font: null,
            name_effect: 'standard',
            name_color_1: '',
            name_color_2: '',
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
    // «Разбудить мальчика» — кто-то из того же канала будит нас (см.
    // ParticipantContextMenu), пока у нас выключен микрофон или звук.
    // Нарочно противный звук, а не тихий пинг, как у демонстрации выше.
    const offWakeRequested = gateway.on('voice_wake_requested', (d) => {
      const current = voiceRef.current
      if (current?.room.kind === 'channel' && current.room.id === d.channel_id) {
        playWakeUpSound()
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
                name_font: d.name_font,
                name_effect: d.name_effect,
                name_color_1: d.name_color_1,
                name_color_2: d.name_color_2,
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
    // Статус канала подправили правым кликом → «Установить статус канала»
    // (см. ChannelDetail.patch на бэке) — персистентное поле Channel.status,
    // в отличие от эфемерного CallTopic (voice_call_state/CallTopic.tsx).
    const offChannelUpdate = gateway.on('channel_update', (d) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === d.server_id
            ? { ...s, channels: s.channels.map((c) => (c.id === d.channel.id ? d.channel : c)) }
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
            // Стиль ника сюда не приезжает (см. аналогичный комментарий у
            // voice_state_update выше) — участник уже виден в
            // conv.participants (User), но конкретно этот payload — только
            // id/username/avatar. Уточнится при следующей загрузке диалога.
            name_font: null,
            name_effect: 'standard',
            name_color_1: '',
            name_color_2: '',
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
              name_font: p.name_font,
              name_effect: p.name_effect,
              name_color_1: p.name_color_1,
              name_color_2: p.name_color_2,
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
      offWakeRequested()
      offProfileUpdate()
      offChannelCreate()
      offChannelUpdate()
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

  // Реакции переключаются по факту «стоит ли она уже у меня» — его считает
  // MessageList из user_ids, отдельно этот флаг нигде не хранится.
  const handleToggleDmReaction = useCallback(
    (messageId: number, emoji: string, mine: boolean) => {
      if (mine) gateway.dmRemoveReaction(messageId, emoji)
      else gateway.dmAddReaction(messageId, emoji)
    },
    [gateway],
  )

  // --- домашний экран: диалоги/группы, друзья, звонки --------------------
  const handleOpenHome = useCallback(() => {
    setServerId(null)
    setChannelId(null)
  }, [])

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
    <div
      className={`app screen-${mobileScreen} ${
        // Голосовой канал — колонки нет никогда; текстовый со СНЯТЫМ
        // тумблером (см. showMembersList/chat-header-members-toggle) — тоже:
        // раньше сюда попадал только voice, а выключенный вручную список
        // участников в тексте оставлял пустую 240px-колонку серым блоком
        // (см. aside ниже), реально не освобождая ширину под чат.
        currentChannel?.kind === 'voice' ||
        (currentChannel?.kind === 'text' && !showMembersList)
          ? 'app-no-members-col'
          : ''
      }`}
    >
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
          onChannelContextMenu={(c, e) => setChannelContextMenuId({ id: c.id, x: e.clientX, y: e.clientY })}
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
                resolveUsername={(id) =>
                  id === user!.id
                    ? user!.username
                    : activeConversation.participants.find((p) => p.id === id)?.username
                }
                mentionCandidates={[user!, ...activeConversation.participants]}
                onRetry={(nonce) => outbox.retry(nonce)}
                onDiscard={(nonce) => outbox.discard(nonce)}
                onAcceptServerInvite={handleAcceptServerInvite}
                onDeclineServerInvite={handleDeclineServerInvite}
                onOpenInvitedServer={handleOpenInvitedServer}
              />
              <MessageInput
                key={`dm-${activeConversation.id}`}
                draftKey={`dm-${activeConversation.id}`}
                loadDraft={loadDraft}
                saveDraft={saveDraft}
                mentionCandidates={activeConversation.participants}
                channelName={conversationDisplayName(activeConversation)}
                hash={false}
                onSend={handleSendDm}
                replyTarget={dmReplyTarget}
                onCancelReply={() => setDmReplyTarget(null)}
                editTarget={dmEditTarget}
                onSaveEdit={handleSaveDmEdit}
                onCancelEdit={() => setDmEditTargetTracked(null)}
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
              resolveUsername={(id) => members.find((m) => m.id === id)?.username}
              mentionCandidates={members}
              onRetry={(nonce) => outbox.retry(nonce)}
              onDiscard={(nonce) => outbox.discard(nonce)}
            />
            <MessageInput
              key={`channel-${currentChannel.id}`}
              draftKey={`channel-${currentChannel.id}`}
              loadDraft={loadDraft}
              saveDraft={saveDraft}
              mentionCandidates={members}
              channelName={currentChannel.name}
              onSend={handleSend}
              replyTarget={replyTarget}
              onCancelReply={() => setReplyTarget(null)}
              editTarget={editTarget}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={() => setEditTargetTracked(null)}
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

      {/* Список участников — только для текстового канала (DM/группа, пустой
          экран без выбранного канала — прячут его, но колонку под пустой
          aside всё равно держат для консистентности раскладки). Голосовой
          канал и текстовый с выключенным вручную тумблером (showMembersList,
          иконка в chat-header) — колонки нет вообще (см. .app-no-members-col
          выше): иначе выключение тумблера просто гасило бы содержимое,
          оставляя пустую 240px-полосу серым блоком вместо реального
          освобождения ширины под чат. */}
      {serverId != null && currentChannel?.kind === 'text' && showMembersList ? (
        <MembersList
          members={members}
          channels={channels}
          roles={rolesForServer(serverId)}
          ownerId={currentServer?.owner ?? -1}
          onOpenProfile={openProfilePopup}
        />
      ) : currentChannel?.kind === 'voice' ||
        (currentChannel?.kind === 'text' && !showMembersList) ? null : (
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
          onRolesChanged={reloadRoles}
          isMobile={isMobile}
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
          onWakeUser={handleWakeUser}
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
      {channelContextMenuId && (() => {
        // Сервер/канал могли исчезнуть (канал удалили, сами вышли) прямо
        // пока меню открыто — тогда просто не рендерим (см. serverContextMenuServerId).
        const menuChannel = currentServer?.channels.find((c) => c.id === channelContextMenuId.id)
        if (!currentServer || !menuChannel) return null
        return (
          <ChannelContextMenu
            channel={menuChannel}
            x={channelContextMenuId.x}
            y={channelContextMenuId.y}
            canManageChannels={!!currentServer.my_permissions?.manage_channels}
            isPinned={currentServer.my_settings.pinned_channel_ids.includes(menuChannel.id)}
            onClose={() => setChannelContextMenuId(null)}
            onInvite={() => setShowChannelInviteId(menuChannel.id)}
            onTogglePin={() => handleTogglePinChannel(currentServer, menuChannel)}
            onCopyLink={() => handleCopyChannelLink(currentServer, menuChannel)}
            onSetStatus={(status) => handleSetChannelStatus(menuChannel, status)}
          />
        )
      })()}
      {showChannelInviteId != null && (() => {
        const inviteChannel = currentServer?.channels.find((c) => c.id === showChannelInviteId)
        if (!currentServer || !inviteChannel) return null
        return (
          <ChannelInviteModal
            server={currentServer}
            channel={inviteChannel}
            people={knownPeople}
            onClose={() => setShowChannelInviteId(null)}
          />
        )
      })()}
      {voiceInvite && (
        <VoiceInviteJoinModal
          preview={voiceInvite.preview}
          loading={voiceInvite.loading}
          error={voiceInvite.error}
          onConfirm={handleConfirmVoiceInvite}
          onClose={() => setVoiceInvite(null)}
        />
      )}
    </div>
    </VoiceProvider>
  )
}
