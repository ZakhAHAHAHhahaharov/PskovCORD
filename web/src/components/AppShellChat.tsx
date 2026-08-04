import { MouseEvent as ReactMouseEvent, useState } from 'react'
import { ChevronLeft, Phone, PhoneOff, Pin, Users } from 'lucide-react'
import { Conversation, Me } from '../api'
import type { useChannelMessages } from '../hooks/useChannelMessages'
import type { useConversationsData } from '../hooks/useConversationsData'
import type { useInviteLinks } from '../hooks/useInviteLinks'
import type { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import type { useServerData } from '../hooks/useServerData'
import type { useVoiceCall } from '../hooks/useVoiceCall'
import { conversationDisplayName } from '../conversation'
import { useNicknamesVersion } from '../nicknames'
import { ComposerDraft } from '../drafts'
import { outbox, pendingAsMessage, PendingMessage } from '../outbox'
import MessageList from './MessageList'
import MessageInput, { MessageInputPrefill } from './MessageInput'
import PinnedMessages from './PinnedMessages'
import MembersList from './MembersList'
import VoiceStage from './VoiceStage'
import { ProfilePopupUser } from './MiniProfilePopup'

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
  handleToggleDmReaction: (messageId: number, emoji: string, mine: boolean) => void
  mentionPrefill: MessageInputPrefill | null
  /** Кого я заблокировал — их сообщения в ленту не попадают. REST-историю
   * фильтрует сервер (см. backend _hide_blocked), здесь отсеиваются те, что
   * пришли живьём по WebSocket. */
  blockedUserIds: Set<number>
}

/** Основная рабочая область — <main> (домашний DM-чат / VoiceStage
 * серверного канала / текстовый чат канала) плюс список участников справа
 * от текстового канала. */
export default function AppShellChat({
  server, conv, voice, participant, channelMessages, inviteLinks,
  user, isMobile, goBackMobile, activeConversation, canDeleteMessages,
  canSendVoiceMessages,
  pendingChannelMessages, pendingDmMessages, loadDraft, saveDraft,
  showMembersList, setShowMembersList, openProfilePopup, handleToggleDmReaction,
  mentionPrefill, blockedUserIds,
}: AppShellChatProps) {
  const { currentServer, channels, currentChannel, serverId, members, rolesForServer } = server
  const visible = <T extends { author: { id: number } }>(list: T[]) =>
    blockedUserIds.size === 0 ? list : list.filter((m) => !blockedUserIds.has(m.author.id))
  // Панель закреплённых — под кнопкой в шапке текстового канала.
  const [pinsOpen, setPinsOpen] = useState(false)
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
            selfUserId={user.id}
            pendingWatchUserId={
              voice.pendingWatch?.channelId === currentChannel.id ? voice.pendingWatch.userId : null
            }
            onConsumedPendingWatch={() => voice.setPendingWatch(null)}
            onRequestWatch={(userId) => voice.handleWatchScreen(userId, currentChannel.id)}
            onOpenProfile={openProfilePopup}
            onParticipantContextMenu={participant.openParticipantContextMenu}
            roomKind="channel"
            isConnected={voice.voice?.room.kind === 'channel' && voice.voice.room.id === currentChannel.id}
            onJoin={() => voice.handleJoinVoice(currentChannel)}
            onLeave={voice.handleLeaveVoice}
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
              {currentChannel.status && (
                <>
                  <span className="chat-header-topic-divider" />
                  <span className="chat-header-topic" title={currentChannel.status}>
                    {currentChannel.status}
                  </span>
                </>
              )}
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
              onToggleReaction={channelMessages.handleToggleReaction}
              resolveUsername={(id) => members.find((m) => m.id === id)?.username}
              mentionCandidates={members}
              onRetry={(nonce) => outbox.retry(nonce)}
              onDiscard={(nonce) => outbox.discard(nonce)}
              onTogglePin={canDeleteMessages ? channelMessages.handleTogglePin : undefined}
              scrollAnchor={channelMessages.scrollAnchor}
              onReachedBottom={channelMessages.handleReachedBottom}
              servers={server.servers}
              conversations={conv.conversations}
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
        />
      ) : currentChannel?.kind === 'voice' ||
        (currentChannel?.kind === 'text' && !showMembersList) ? null : (
        <aside className="members-list" />
      )}
    </>
  )
}
