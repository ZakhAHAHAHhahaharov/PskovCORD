import { MouseEvent as ReactMouseEvent } from 'react'
import { Bell, BellOff, Hash, Lock, MessagesSquare, MoreHorizontal, X } from 'lucide-react'
import { Channel, Conversation, MentionCandidate, Me, Server } from '../api'
import ThreadSearch from './ThreadSearch'
import type { useChannelMessages } from '../hooks/useChannelMessages'
import { ComposerDraft } from '../drafts'
import { outbox, pendingAsMessage, PendingMessage } from '../outbox'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import { ProfilePopupUser } from './MiniProfilePopup'

/**
 * Ветка — КОЛОНКА СПРАВА, рядом с родительским каналом, а не подмена
 * основного чата: в этом весь смысл веток, иначе, уйдя в ответвление, теряешь
 * из виду разговор, от которого оно ответвилось. Устроена как панель
 * модератора (см. ModeratorPanel): колонку в сетке выдаёт
 * `.app.app-thread-open`, рендерится она в слое оверлеев после `aside`, и
 * обычная авторасстановка grid ставит её последней.
 *
 * Своя лента и свой композер — со своим экземпляром useChannelMessages (см.
 * AppShell): ветка это отдельный канал, у неё свои история, черновик,
 * незавершённое редактирование и курсор прочтения.
 *
 * Закрытая ветка (Channel.archived) читается и пишется как обычная — писать в
 * неё не запрещено, наоборот: сообщение возвращает её из архива само (см.
 * backend chat.consumers._create_message). Поэтому композер здесь не
 * блокируется, а состояние показано пометкой в шапке.
 */
export default function ThreadPanel({
  thread,
  parent,
  threadMessages,
  pendingMessages,
  user,
  members,
  servers,
  conversations,
  canModerate,
  canSendVoiceMessages,
  blockedUserIds,
  loadDraft,
  saveDraft,
  onClose,
  onToggleMuted,
  onOpenMenu,
  searchOpen,
  onCloseSearch,
  onJumpToMessage,
  onOpenProfile,
  onUserContextMenu,
}: {
  thread: Channel
  /** Родительский канал — в подзаголовке «в #канал». null, если он почему-то
   * не найден среди каналов сервера (приватный, доступ отозвали) — тогда
   * подзаголовка просто нет, а сама ветка остаётся читаемой. */
  parent: Channel | null
  threadMessages: ReturnType<typeof useChannelMessages>
  pendingMessages: PendingMessage[]
  user: Me
  members: MentionCandidate[]
  servers: Server[]
  conversations: Conversation[]
  canModerate: boolean
  canSendVoiceMessages: boolean
  blockedUserIds: Set<number>
  loadDraft: (key: string) => ComposerDraft | undefined
  saveDraft: (key: string, draft: ComposerDraft) => void
  onClose: () => void
  onToggleMuted: (muted: boolean) => void
  /** Многоточие в шапке — открыть меню ветки у этой кнопки (см.
   * ThreadContextMenu; рисует его владелец состояния, а не панель). */
  onOpenMenu: (anchor: DOMRect) => void
  searchOpen: boolean
  onCloseSearch: () => void
  /** Клик по найденному сообщению — перейти к нему в ленте ветки. */
  onJumpToMessage: (messageId: number) => void
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  onUserContextMenu: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  const visible = threadMessages.messages.filter(
    (m) => !blockedUserIds.has(m.author.id),
  )

  return (
    <aside className="thread-panel">
      <header className="thread-panel-head">
        <span className="thread-panel-icon">
          <MessagesSquare size={16} />
        </span>
        <div className="thread-panel-identity">
          <span className="thread-panel-name" title={thread.name}>
            {thread.name}
          </span>
          {parent && (
            <span className="thread-panel-parent">
              <Hash size={11} />
              {parent.name}
            </span>
          )}
        </div>
        {thread.locked && (
          <span className="thread-panel-archived-tag" title="Писать могут только модераторы">
            <Lock size={10} /> закрыта на запись
          </span>
        )}
        {thread.archived && !thread.locked && (
          <span className="thread-panel-archived-tag">закрыта</span>
        )}
        {/* Заглушение — отдельной кнопкой, а не пунктом меню: это переключатель
            с двумя состояниями, и по перечёркнутому колокольчику видно
            текущее, не открывая меню. */}
        <button
          type="button"
          className={`thread-panel-action ${thread.my_settings.muted ? 'active' : ''}`}
          title={thread.my_settings.muted ? 'Включить уведомления ветки' : 'Заглушить ветку'}
          onClick={() => onToggleMuted(!thread.my_settings.muted)}
        >
          {thread.my_settings.muted ? <BellOff size={16} /> : <Bell size={16} />}
        </button>
        <button
          type="button"
          className="thread-panel-action"
          title="Ещё"
          onClick={(e) => onOpenMenu(e.currentTarget.getBoundingClientRect())}
        >
          <MoreHorizontal size={18} />
        </button>
        <button
          type="button"
          className="thread-panel-action"
          title="Закрыть панель"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      {/* Поиск и закреплённые занимают место ленты, а не наслаиваются на неё:
          в 420px колонке всплывающая панель накрыла бы ровно то, ради чего её
          открыли. Возврат — крестиком в их собственной шапке. */}
      {searchOpen && (
        <ThreadSearch
          channelId={thread.id}
          onClose={onCloseSearch}
          onPick={onJumpToMessage}
        />
      )}

      <MessageList
        messages={[
          ...visible,
          ...pendingMessages.map((p) => pendingAsMessage(p, user)),
        ]}
        currentUserId={user.id}
        canModerate={canModerate}
        editingId={threadMessages.editTarget?.id ?? null}
        onDelete={threadMessages.handleDeleteMessage}
        onEditRequest={threadMessages.handleEditRequest}
        onReply={threadMessages.handleReplyRequest}
        onOpenProfile={onOpenProfile}
        onUserContextMenu={onUserContextMenu}
        onToggleReaction={threadMessages.handleToggleReaction}
        resolveUsername={(id) => members.find((m) => m.id === id)?.username}
        mentionCandidates={members}
        onRetry={(nonce) => outbox.retry(nonce)}
        onDiscard={(nonce) => outbox.discard(nonce)}
        onTogglePin={canModerate ? threadMessages.handleTogglePin : undefined}
        scrollAnchor={threadMessages.scrollAnchor}
        highlightMessageId={threadMessages.highlightMessageId}
        onReachedBottom={threadMessages.handleReachedBottom}
        servers={servers}
        conversations={conversations}
        // Ветка в ветке не заводится (см. backend ChannelThreads), поэтому ни
        // плашки, ни пункта «Создать ветку» здесь нет — threadOf/onCreateThread
        // не передаются вовсе.
      />
      <MessageInput
        key={`channel-${thread.id}`}
        draftKey={`channel-${thread.id}`}
        loadDraft={loadDraft}
        saveDraft={saveDraft}
        mentionCandidates={members}
        channelName={thread.name}
        hash={false}
        onSend={threadMessages.handleSend}
        replyTarget={threadMessages.replyTarget}
        onCancelReply={() => threadMessages.setReplyTarget(null)}
        editTarget={threadMessages.editTarget}
        onSaveEdit={threadMessages.handleSaveEdit}
        onCancelEdit={() => threadMessages.setEditTargetTracked(null)}
        canSendVoice={canSendVoiceMessages}
      />
    </aside>
  )
}
