import { useCallback, useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useChannelMessages } from '../hooks/useChannelMessages'
import { useConversationsData } from '../hooks/useConversationsData'
import { useGatewayEvents } from '../hooks/useGatewayEvents'
import { useInviteLinks } from '../hooks/useInviteLinks'
import { useMobileNav } from '../hooks/useMobileNav'
import { useNameFonts } from '../hooks/useNameFonts'
import { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import { useServerData } from '../hooks/useServerData'
import { useUserRelations } from '../hooks/useUserRelations'
import { useConversationContextMenu } from '../hooks/useConversationContextMenu'
import { useVoiceCall } from '../hooks/useVoiceCall'
import { ChatMessageBase } from '../api'
import { useAuth } from '../auth'
import { ComposerDraft, loadComposerDraft, saveComposerDraft } from '../drafts'
import { useGateway } from '../gateway'
import { outbox, usePendingMessages, OutboxTarget } from '../outbox'
import AppShellChat from './AppShellChat'
import AppShellNav from './AppShellNav'
import AppShellOverlays from './AppShellOverlays'
import VoiceProvider from './VoiceProvider'
import { ProfilePopupTarget, ProfilePopupUser } from './MiniProfilePopup'

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
    setServerRoles, setServerMembersCache,
    fetchedServerDataIds, serversRef,
    setUnreadChannelIds,
    showServerInviteId,
    currentServer, channels, currentChannel,
    channelServerIdRef, shouldNotifyRef,
    selectServer,
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
  // ниже), поэтому текст живёт снаружи, а не локальным стейтом компонента.
  // Хранилище — localStorage (см. drafts.ts): набранное переживает и
  // перезагрузку страницы, и закрытие вкладки, а не только смену канала.
  const draftScope = user?.id ?? 0
  const saveDraft = useCallback(
    (key: string, draft: ComposerDraft) => saveComposerDraft(draftScope, key, draft),
    [draftScope],
  )
  const loadDraft = useCallback(
    (key: string) => loadComposerDraft(draftScope, key),
    [draftScope],
  )
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
    setDmMessages, dmMessagesRef,
    setUnreadConversationIds,
    setFriends,
  } = conversationsData
  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null

  const voiceCall = useVoiceCall(
    gateway, user, members, channels, conversations, activeConversation,
    setChannelId, setServerId, setActiveConversationId,
  )
  const {
    voice, setVoice, voiceRef,
    setDmCallParticipants,
    setIncomingCall,
    setActiveMuteVoteChannelId,
    setMuteVote,
    handleJoinVoice, handleVoiceStatus,
  } = voiceCall

  const participantContextMenu = useParticipantContextMenu(
    channels, currentChannel, setChannelId, setServerId, setActiveConversationId,
  )
  const { mentionPrefill } = participantContextMenu

  // Игнор и блокировка (см. useUserRelations): множества нужны и ленте
  // (скрыть сообщения заблокированных, пришедшие живьём по WS), и
  // уведомлениям (молчать про игнорируемых).
  const relations = useUserRelations()
  const { blockedUserIds, setBlockedUserIds, ignoredUserIds, setIgnoredUserIds } = relations
  // Через ref — большой gateway-эффект намеренно не держит быстро меняющиеся
  // значения в зависимостях (см. комментарий там же).
  const ignoredUserIdsRef = useRef(ignoredUserIds)
  ignoredUserIdsRef.current = ignoredUserIds

  const conversationMenu = useConversationContextMenu({
    conversations,
    setConversations,
    setUnreadConversationIds,
    setActiveConversationId,
    activeConversationId,
    onStartCall: (conversationId) => voiceCall.handleDmVoiceJoin(conversationId),
    onOpenProfile: (conversation, x, y) => {
      const peer = conversation.participants[0]
      if (peer) setProfilePopup({ user: peer, x, y })
    },
    setBlockedUserIds,
    setIgnoredUserIds,
    setFriends,
  })

  const channelMessages = useChannelMessages(currentChannel, channelId, gateway, pendingEditsRef)
  const { setMessages, messagesRef } = channelMessages

  const inviteLinks = useInviteLinks(servers, setServers, selectServer, handleJoinVoice)

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
    channelServerIdRef, shouldNotifyRef, ignoredUserIdsRef, fetchedServerDataIds,
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
        onConversationContextMenu={conversationMenu.openConversationContextMenu}
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
        blockedUserIds={blockedUserIds}
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
        conversationMenu={conversationMenu}
        servers={servers}
      />
    </div>
    </VoiceProvider>
  )
}
