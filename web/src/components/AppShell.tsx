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
import { useGatewayEvents } from '../hooks/useGatewayEvents'
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
import AppShellChat from './AppShellChat'
import AppShellNav from './AppShellNav'
import AppShellOverlays from './AppShellOverlays'
import VoiceProvider, { VoiceStatus } from './VoiceProvider'
import { MessageInputPrefill } from './MessageInput'
import { ProfilePopupTarget, ProfilePopupUser } from './MiniProfilePopup'

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

  useGatewayEvents({
    gateway, channelId, serverId, activeConversationId,
    userRef, voiceRef, conversationsRef, serversRef, messagesRef, dmMessagesRef,
    channelServerIdRef, shouldNotifyRef, fetchedServerDataIds,
    setMessages, setMembers, setServers, setServerRoles, setServerMembersCache,
    setUnreadChannelIds, setChannelId, setServerId, setVoice, setDmCallParticipants,
    setActiveMuteVoteChannelId, setMuteVote, setIncomingCall,
    setConversations, setDmMessages, setUnreadConversationIds, setActiveConversationId,
    setFriends,
  })

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
      <AppShellNav
        server={serverData}
        conv={conversationsData}
        voice={voiceCall}
        participant={participantContextMenu}
        user={user!}
        navigateToContent={navigateToContent}
        openMobileSettings={openMobileSettings}
        openProfilePopup={openProfilePopup}
        onOpenProfile={() => setShowProfile(true)}
      />

      <AppShellChat
        server={serverData}
        conv={conversationsData}
        voice={voiceCall}
        participant={participantContextMenu}
        channelMessages={channelMessages}
        inviteLinks={inviteLinks}
        user={user!}
        isMobile={isMobile}
        goBackMobile={goBackMobile}
        activeConversation={activeConversation}
        canDeleteMessages={canDeleteMessages}
        pendingChannelMessages={pendingChannelMessages}
        pendingDmMessages={pendingDmMessages}
        loadDraft={loadDraft}
        saveDraft={saveDraft}
        showMembersList={showMembersList}
        setShowMembersList={setShowMembersList}
        openProfilePopup={openProfilePopup}
        handleToggleDmReaction={handleToggleDmReaction}
        mentionPrefill={mentionPrefill}
      />

      <AppShellOverlays
        server={serverData}
        conv={conversationsData}
        voice={voiceCall}
        participant={participantContextMenu}
        inviteLinks={inviteLinks}
        user={user!}
        isMobile={isMobile}
        logout={logout}
        showSettings={showSettings}
        closeSettings={closeSettings}
        showProfile={showProfile}
        setShowProfile={setShowProfile}
        profilePopup={profilePopup}
        setProfilePopup={setProfilePopup}
      />
    </div>
    </VoiceProvider>
  )
}
