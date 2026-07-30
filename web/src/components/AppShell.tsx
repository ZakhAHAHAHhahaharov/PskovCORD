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
