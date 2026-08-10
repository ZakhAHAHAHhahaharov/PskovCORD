import { MouseEvent as ReactMouseEvent, useState } from 'react'
import { ChevronLeft, MessageSquare, Phone, PhoneOff, Pin, Search, Users } from 'lucide-react'
import { Channel, Conversation, Me } from '../api'
import type { useChannelMessages } from '../hooks/useChannelMessages'
import type { useConversationsData } from '../hooks/useConversationsData'
import type { useInviteLinks } from '../hooks/useInviteLinks'
import type { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import type { useServerData } from '../hooks/useServerData'
import type { useVoiceCall } from '../hooks/useVoiceCall'
import { conversationDisplayName } from '../conversation'
import { renderSimpleMarkdown } from '../markdown'
import { useNicknamesVersion } from '../nicknames'
import { ComposerDraft } from '../drafts'
import { EMOJI_TOKEN_RE, STICKER_TOKEN_RE } from '../emoji'
import { outbox, pendingAsMessage, PendingMessage } from '../outbox'
import { useGateway } from '../gateway'
import { channelPlace, conversationPlace, shouldSendTyping } from '../typing'
import MessageList from './MessageList'
import MessageInput, { MessageInputPrefill } from './MessageInput'
import TypingIndicator from './TypingIndicator'
import PinnedMessages from './PinnedMessages'
import MembersList from './MembersList'
import VoiceStage from './VoiceStage'
import { ProfilePopupUser } from './MiniProfilePopup'

/** Сколько символов сообщения предлагать как название ветки. Совпадает с
 * THREAD_NAME_FROM_MESSAGE на бэкенде — тем же куском он назовёт ветку, если
 * название не прислать вовсе. */
const THREAD_NAME_FROM_MESSAGE = 60

/** Название ветки по тексту сообщения. Токены стикеров и кастомных эмодзи в
 * сыром content лежат как «<sticker:7>»/«<:кот:1>» (см. emoji.ts) — попади
 * они в имя канала как есть, в сайдбаре висела бы строка «<sticker:7>».
 * Стикер вырезается целиком (имени в его токене нет), от эмодзи остаётся имя.
 * Сообщение из одних стикеров и картинок даёт пустую строку — название
 * придётся ввести руками, кнопка в модалке до этого заблокирована. */
function threadNameFromMessage(content: string): string {
  const text = content
    .replace(STICKER_TOKEN_RE, ' ')
    .replace(EMOJI_TOKEN_RE, (_m, _animated, name: string) => name)
  return text.split(/\s+/).filter(Boolean).join(' ').slice(0, THREAD_NAME_FROM_MESSAGE)
}

interface AppShellChatProps {
  server: ReturnType<typeof useServerData>
  conv: ReturnType<typeof useConversationsData>
  voice: ReturnType<typeof useVoiceCall>
  participant: ReturnType<typeof useParticipantContextMenu>
  channelMessages: ReturnType<typeof useChannelMessages>
  inviteLinks: ReturnType<typeof useInviteLinks>
  user: Me
  isMobile: boolean
  goBackMobile: () => void
  activeConversation: Conversation | null
  canDeleteMessages: boolean
  /** Право «Отправление голосовых сообщений» на ТЕКУЩЕМ сервере. В личке и
   * группе не спрашивается — ролей там нет (см. AppShell). */
  canSendVoiceMessages: boolean
  pendingChannelMessages: PendingMessage[]
  pendingDmMessages: PendingMessage[]
  loadDraft: (key: string) => ComposerDraft | undefined
  saveDraft: (key: string, draft: ComposerDraft) => void
  showMembersList: boolean
  setShowMembersList: (fn: (v: boolean) => boolean) => void
  openProfilePopup: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  /** Правый клик по человеку вне списка друзей — сейчас только по
   * отреагировавшему на сообщение (см. MessageReactionsModal/MessageList). */
  onUserContextMenu: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  handleToggleDmReaction: (messageId: number, emoji: string, mine: boolean) => void
  mentionPrefill: MessageInputPrefill | null
  /** Кого я заблокировал — их сообщения в ленту не попадают. REST-историю
   * фильтрует сервер (см. backend _hide_blocked), здесь отсеиваются те, что
   * пришли живьём по WebSocket. */
  blockedUserIds: Set<number>
  /** Открыть поиск по сообщениям. Сама модалка живёт в AppShellOverlays —
   * она перекрывает всё приложение, а не только область чата. */
  onOpenSearch: () => void
}

/** Основная рабочая область — <main> (домашний DM-чат / VoiceStage
 * серверного канала / текстовый чат канала) плюс список участников справа
 * от текстового канала. */
export default function AppShellChat({
  server, conv, voice, participant, channelMessages, inviteLinks,
  user, isMobile, goBackMobile, activeConversation, canDeleteMessages,
  canSendVoiceMessages,
  pendingChannelMessages, pendingDmMessages, loadDraft, saveDraft,
  showMembersList, setShowMembersList, openProfilePopup, onUserContextMenu,
  handleToggleDmReaction,
  mentionPrefill, blockedUserIds, onOpenSearch,
}: AppShellChatProps) {
  const { currentServer, channels, currentChannel, serverId, members, rolesForServer } = server
  const visible = <T extends { author: { id: number } }>(list: T[]) =>
    blockedUserIds.size === 0 ? list : list.filter((m) => !blockedUserIds.has(m.author.id))
  // Панель закреплённых — под кнопкой в шапке текстового канала.
  const [pinsOpen, setPinsOpen] = useState(false)
  // Открыт ли текстовый чат голосового канала (иконка в углу «сцены»
  // звонка). Закрыт по умолчанию: заходят в голосовой канал ради разговора,
  // а чат — дополнение к нему, а не то, ради чего сюда пришли.
  const [voiceChatOpen, setVoiceChatOpen] = useState(false)
  const gateway = useGateway()

  /** Ветка, выросшая из этого сообщения, — для плашки под ним (см.
   * MessageList.threadOf). Ищем среди каналов сервера: ветки приезжают
   * обычными каналами, отдельного их списка на клиенте нет. */
  const threadOf = (messageId: number) =>
    channels.find((c) => c.kind === 'thread' && c.source_message === messageId)
  /** Ветка по id — для системной записи «X начинает ветку»: её собственный
   * снимок сделан в момент создания, показывать надо текущее состояние. */
  const threadById = (threadId: number) => channels.find((c) => c.id === threadId)
  const openThreadMenu = (thread: Channel, e: ReactMouseEvent) =>
    server.setThreadContextMenu({ id: thread.id, x: e.clientX, y: e.clientY })
  const showAllThreads = () => {
    if (currentChannel) server.setThreadListChannelId(currentChannel.id)
  }
  /** «Создать ветку» из сообщения — если ветка уже есть, просто открываем её
   * (модалку с названием спрашивать не о чем). */
  const handleCreateThreadFromMessage = (messageId: number, content: string) => {
    if (!currentChannel) return
    const existing = threadOf(messageId)
    if (existing) {
      server.handleOpenThread(existing)
      return
    }
    server.setCreateThreadTarget({
      channelId: currentChannel.id,
      messageId,
      // Название по умолчанию — начало самого сообщения; ту же длину и ту же
      // очистку от токенов делает и бэкенд, если название вовсе не прислать
      // (см. THREAD_NAME_FROM_MESSAGE/_thread_name_from_message).
      suggestedName: threadNameFromMessage(content),
    })
  }
  // Имя собеседника в шапке считает conversationDisplayName из стора
  // никнеймов — подписка на его версию перерисовывает шапку при смене
  // никнейма (сам activeConversation при этом не меняется).
  useNicknamesVersion()

  return (
    <>
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
                {voice.voice?.room.kind === 'conversation' && voice.voice.room.id === activeConversation.id ? (
                  <button className="icon-btn dm-call-leave" title="Завершить звонок" onClick={voice.handleLeaveVoice}>
                    <PhoneOff size={16} />
                  </button>
                ) : (
                  <button
                    className="icon-btn"
                    title="Позвонить"
                    onClick={() => voice.handleDmVoiceJoin(activeConversation.id)}
                  >
                    <Phone size={16} />
                  </button>
                )}
              </header>
              {voice.isInDmCall && (
                <div className="dm-voicestage-wrap" style={{ height: voice.dmVoiceStageHeight }}>
                  <VoiceStage
                    key={activeConversation.id}
                    roomId={activeConversation.id}
                    roomName={conversationDisplayName(activeConversation)}
                    roster={voice.dmRoster}
                    selfUserId={user.id}
                    pendingWatchUserId={voice.dmPendingWatchUserId}
                    onConsumedPendingWatch={() => voice.setDmPendingWatchUserId(null)}
                    onRequestWatch={voice.handleDmRequestWatch}
                    onOpenProfile={openProfilePopup}
                    onParticipantContextMenu={participant.openParticipantContextMenu}
                    roomKind="conversation"
                    // Этот VoiceStage рендерится только пока isInDmCall — то
                    // есть мы всегда уже подключены, VoiceLanding здесь не
                    // нужен (для звонка в личке/группе нет отдельного "canала"
                    // без входа, только сам звонок).
                    isConnected
                    onJoin={() => voice.handleDmVoiceJoin(activeConversation.id)}
                    onLeave={voice.handleLeaveVoice}
                  />
                  <div
                    className="dm-voicestage-resize"
                    onMouseDown={voice.handleDmVoiceStageResizeStart}
                    title="Потянуть, чтобы изменить размер"
                  />
                </div>
              )}
              <MessageList
                // Неотправленные дописываются в конец ленты: у них ещё нет id
                // на сервере, но человек должен видеть, что он написал.
                messages={[
                  ...visible(conv.dmMessages),
                  ...pendingDmMessages.map((p) => pendingAsMessage(p, user)),
                ]}
                currentUserId={user.id}
                canModerate={false}
                editingId={conv.dmEditTarget?.id ?? null}
                onDelete={conv.handleDeleteDmMessage}
                onEditRequest={conv.handleDmEditRequest}
                onReply={conv.handleDmReplyRequest}
                onOpenProfile={openProfilePopup}
                onUserContextMenu={onUserContextMenu}
                onToggleReaction={handleToggleDmReaction}
                resolveUsername={(id) =>
                  id === user.id
                    ? user.username
                    : activeConversation.participants.find((p) => p.id === id)?.username
                }
                mentionCandidates={[user, ...activeConversation.participants]}
                servers={server.servers}
                conversations={conv.conversations}
                onRetry={(nonce) => outbox.retry(nonce)}
                onDiscard={(nonce) => outbox.discard(nonce)}
                onAcceptServerInvite={inviteLinks.handleAcceptServerInvite}
                onDeclineServerInvite={inviteLinks.handleDeclineServerInvite}
                onOpenInvitedServer={inviteLinks.handleOpenInvitedServer}
                // Курсор прочтения персистится только для серверных каналов
                // (см. AppShellChat ниже и useChannelMessages) — в личке/
                // группе кнопка «вниз» и автопрокрутка работают как обычно,
                // просто без сохранения позиции между заходами: scrollAnchor
                // здесь только сбрасывает прокрутку на низ при смене диалога.
                scrollAnchor={{ key: `dm-${activeConversation.id}`, target: 'bottom' }}
              />
              <TypingIndicator
                place={conversationPlace(activeConversation.id)}
                selfId={user.id}
                resolveName={(id) =>
                  activeConversation.participants.find((p) => p.id === id)?.username
                }
              />
              <MessageInput
                key={`dm-${activeConversation.id}`}
                draftKey={`dm-${activeConversation.id}`}
                loadDraft={loadDraft}
                saveDraft={saveDraft}
                mentionCandidates={activeConversation.participants}
                channelName={conversationDisplayName(activeConversation)}
                hash={false}
                onSend={conv.handleSendDm}
                replyTarget={conv.dmReplyTarget}
                onCancelReply={() => conv.setDmReplyTarget(null)}
                editTarget={conv.dmEditTarget}
                onSaveEdit={conv.handleSaveDmEdit}
                onCancelEdit={() => conv.setDmEditTargetTracked(null)}
                prefill={mentionPrefill}
                onTyping={() => {
                  const place = conversationPlace(activeConversation.id)
                  if (shouldSendTyping(place)) gateway.dmTypingStart(activeConversation.id)
                }}
              />
            </>
          ) : (
            <div className="chat-empty">Выбери диалог слева или начни новый</div>
          )
        ) : currentChannel && currentChannel.kind === 'voice' ? (
          /* Голосовой канал — «сцена» звонка плюс его собственный текстовый
             чат, как в Discord. Чат — те же Message с channel=<этот канал>
             (отдельной модели под них нет, см. backend chat.models.Channel
             WRITABLE_KINDS), поэтому он умеет всё то же, что и обычная лента:
             ответы, реакции, закрепления, ветки. */
          <div className={`voice-with-chat ${voiceChatOpen ? 'chat-open' : ''}`}>
            <VoiceStage
              key={currentChannel.id}
              roomId={currentChannel.id}
              roomName={currentChannel.name}
              roster={members.filter((m) => m.voice_channel === String(currentChannel.id))}
              selfUserId={user.id}
              pendingWatchUserId={
                voice.pendingWatch?.channelId === currentChannel.id ? voice.pendingWatch.userId : null
              }
              onConsumedPendingWatch={() => voice.setPendingWatch(null)}
              onRequestWatch={(userId) => voice.handleWatchScreen(userId, currentChannel.id)}
              onOpenProfile={openProfilePopup}
              onParticipantContextMenu={participant.openParticipantContextMenu}
              roomKind="channel"
              serverId={currentChannel.server}
              canManageSounds={!!currentServer?.my_permissions?.create_expressions}
              isConnected={voice.voice?.room.kind === 'channel' && voice.voice.room.id === currentChannel.id}
              onJoin={() => voice.handleJoinVoice(currentChannel)}
              onLeave={voice.handleLeaveVoice}
              isMobile={isMobile}
              onBack={goBackMobile}
            />
            <button
              type="button"
              className={`voice-chat-toggle ${voiceChatOpen ? 'active' : ''}`}
              title={voiceChatOpen ? 'Скрыть чат канала' : 'Чат канала'}
              onClick={() => setVoiceChatOpen((v) => !v)}
            >
              <MessageSquare size={16} />
            </button>
            {voiceChatOpen && (
              <aside className="voice-chat-panel">
                <header className="voice-chat-panel-head">
                  <MessageSquare size={14} /> Чат канала
                </header>
                <MessageList
                  messages={[
                    ...visible(channelMessages.messages),
                    ...pendingChannelMessages.map((p) => pendingAsMessage(p, user)),
                  ]}
                  currentUserId={user.id}
                  canModerate={canDeleteMessages}
                  editingId={channelMessages.editTarget?.id ?? null}
                  onDelete={channelMessages.handleDeleteMessage}
                  onEditRequest={channelMessages.handleEditRequest}
                  onReply={channelMessages.handleReplyRequest}
                  onOpenProfile={openProfilePopup}
                  onUserContextMenu={onUserContextMenu}
                  onToggleReaction={channelMessages.handleToggleReaction}
                  resolveUsername={(id) => members.find((m) => m.id === id)?.username}
                  mentionCandidates={members}
                  onRetry={(nonce) => outbox.retry(nonce)}
                  onDiscard={(nonce) => outbox.discard(nonce)}
                  onTogglePin={canDeleteMessages ? channelMessages.handleTogglePin : undefined}
                  scrollAnchor={channelMessages.scrollAnchor}
                  highlightMessageId={channelMessages.highlightMessageId}
                  onReachedBottom={channelMessages.handleReachedBottom}
                  servers={server.servers}
                  conversations={conv.conversations}
                  threadOf={threadOf}
                  threadById={threadById}
                  onOpenThread={server.handleOpenThread}
                  onCreateThread={(m) => handleCreateThreadFromMessage(m.id, m.content)}
                  onThreadContextMenu={openThreadMenu}
                  onShowAllThreads={showAllThreads}
                />
                <MessageInput
                  key={`channel-${currentChannel.id}`}
                  draftKey={`channel-${currentChannel.id}`}
                  loadDraft={loadDraft}
                  saveDraft={saveDraft}
                  mentionCandidates={members}
                  channelName={currentChannel.name}
                  onSend={channelMessages.handleSend}
                  replyTarget={channelMessages.replyTarget}
                  onCancelReply={() => channelMessages.setReplyTarget(null)}
                  editTarget={channelMessages.editTarget}
                  onSaveEdit={channelMessages.handleSaveEdit}
                  onCancelEdit={() => channelMessages.setEditTargetTracked(null)}
                  prefill={mentionPrefill}
                  canSendVoice={canSendVoiceMessages}
                />
              </aside>
            )}
          </div>
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
              {currentChannel.status && (
                <>
                  <span className="chat-header-topic-divider" />
                  <span className="chat-header-topic" title={currentChannel.status}>
                    {renderSimpleMarkdown(currentChannel.status, 'chat-header-topic')}
                  </span>
                </>
              )}
              <button
                type="button"
                className="chat-header-pin-btn"
                title="Поиск по сообщениям (Ctrl+K)"
                onClick={onOpenSearch}
              >
                <Search size={18} />
              </button>
              <div className="chat-header-pins">
                <button
                  type="button"
                  className={`chat-header-pin-btn ${pinsOpen ? 'active' : ''}`}
                  title="Закреплённые сообщения"
                  onClick={() => setPinsOpen((v) => !v)}
                >
                  <Pin size={18} />
                </button>
                {pinsOpen && (
                  <PinnedMessages
                    channelId={currentChannel.id}
                    canPin={canDeleteMessages}
                    onUnpin={(messageId) => channelMessages.handleTogglePin(messageId, false)}
                    onClose={() => setPinsOpen(false)}
                  />
                )}
              </div>
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
                ...visible(channelMessages.messages),
                ...pendingChannelMessages.map((p) => pendingAsMessage(p, user)),
              ]}
              currentUserId={user.id}
              canModerate={canDeleteMessages}
              editingId={channelMessages.editTarget?.id ?? null}
              onDelete={channelMessages.handleDeleteMessage}
              onEditRequest={channelMessages.handleEditRequest}
              onReply={channelMessages.handleReplyRequest}
              onOpenProfile={openProfilePopup}
              onUserContextMenu={onUserContextMenu}
              onToggleReaction={channelMessages.handleToggleReaction}
              resolveUsername={(id) => members.find((m) => m.id === id)?.username}
              mentionCandidates={members}
              onRetry={(nonce) => outbox.retry(nonce)}
              onDiscard={(nonce) => outbox.discard(nonce)}
              onTogglePin={canDeleteMessages ? channelMessages.handleTogglePin : undefined}
              scrollAnchor={channelMessages.scrollAnchor}
              highlightMessageId={channelMessages.highlightMessageId}
              onReachedBottom={channelMessages.handleReachedBottom}
              servers={server.servers}
              conversations={conv.conversations}
              threadOf={threadOf}
              threadById={threadById}
              onOpenThread={server.handleOpenThread}
              onCreateThread={(m) => handleCreateThreadFromMessage(m.id, m.content)}
              onThreadContextMenu={openThreadMenu}
              onShowAllThreads={showAllThreads}
            />
            <TypingIndicator
              place={channelPlace(currentChannel.id)}
              selfId={user.id}
              resolveName={(id) => members.find((m) => m.id === id)?.username}
            />
            <MessageInput
              key={`channel-${currentChannel.id}`}
              draftKey={`channel-${currentChannel.id}`}
              loadDraft={loadDraft}
              saveDraft={saveDraft}
              mentionCandidates={members}
              channelName={currentChannel.name}
              onSend={channelMessages.handleSend}
              replyTarget={channelMessages.replyTarget}
              onCancelReply={() => channelMessages.setReplyTarget(null)}
              editTarget={channelMessages.editTarget}
              onSaveEdit={channelMessages.handleSaveEdit}
              onCancelEdit={() => channelMessages.setEditTargetTracked(null)}
              prefill={mentionPrefill}
              canSendVoice={canSendVoiceMessages}
              onTyping={() => {
                const place = channelPlace(currentChannel.id)
                if (shouldSendTyping(place)) gateway.typingStart(currentChannel.id)
              }}
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
          в AppShell): иначе выключение тумблера просто гасило бы содержимое,
          оставляя пустую 240px-полосу серым блоком вместо реального
          освобождения ширины под чат. */}
      {serverId != null && currentChannel?.kind === 'text' && showMembersList ? (
        <MembersList
          members={members}
          channels={channels}
          roles={rolesForServer(serverId)}
          ownerId={currentServer?.owner ?? -1}
          onOpenProfile={openProfilePopup}
          onUserContextMenu={onUserContextMenu}
        />
      ) : currentChannel?.kind === 'voice' || (currentChannel?.kind === 'text' && !showMembersList) ? null : (
        <aside className="members-list" />
      )}
    </>
  )
}
