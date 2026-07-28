import { useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertCircle, Check, Clock, Reply, Pencil, RotateCw, SmilePlus, Trash2,
} from 'lucide-react'
import { ChatMessageBase } from '../api'
import { DeliveryStatus, DELIVERY_STATUS_PRESENTATION } from '../outbox'
import { QUICK_REACTIONS } from '../emoji'
import Avatar from './Avatar'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'
import MessageAttachments from './MessageAttachments'
import MessageReactions from './MessageReactions'
import ServerInviteCard from './ServerInviteCard'
import { ProfilePopupUser } from './MiniProfilePopup'

/** Сообщение в ленте. Неотправленные приходят сюда в той же форме, что и
 * настоящие (см. outbox.pendingAsMessage) — список не должен знать про два
 * разных типа, — но с отрицательным id и статусом доставки. */
export type ListMessage = ChatMessageBase & {
  pendingNonce?: string
  deliveryStatus?: DeliveryStatus
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Индикатор доставки — только на СВОИХ сообщениях. Иконки подобраны здесь,
 * а подписи и классы берутся из DELIVERY_STATUS_PRESENTATION (см. outbox.ts):
 * вид индикатора кастомизируется там, в одном месте. */
function DeliveryIndicator({ status }: { status: DeliveryStatus }) {
  const { label, className } = DELIVERY_STATUS_PRESENTATION[status]
  const icon =
    status === 'sending' ? (
      <Clock size={12} />
    ) : status === 'delivered' ? (
      <Check size={12} />
    ) : (
      <AlertCircle size={12} />
    )
  return (
    <span className={`msg-status ${className}`} title={label}>
      {icon}
    </span>
  )
}

export default function MessageList({
  messages,
  currentUserId,
  canModerate,
  editingId,
  onDelete,
  onEditRequest,
  onReply,
  onOpenProfile,
  onToggleReaction,
  onRetry,
  onDiscard,
  onAcceptServerInvite,
  onDeclineServerInvite,
  onOpenInvitedServer,
}: {
  messages: ListMessage[]
  currentUserId: number
  /** Владелец сервера — может удалять чужие сообщения (но не редактировать).
   * Для диалогов/групп всегда false — там нет модератора, см. ProfileModal/AppShell. */
  canModerate: boolean
  /** id сообщения, которое сейчас редактируется внизу в композере. */
  editingId: number | null
  onDelete: (messageId: number) => void
  onEditRequest: (message: ChatMessageBase) => void
  onReply: (message: ChatMessageBase) => void
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  /** Поставить/снять реакцию. mine — стоит ли она уже от нас. */
  onToggleReaction: (messageId: number, emoji: string, mine: boolean) => void
  /** Повторить отправку неотправленного сообщения (кнопка на «не доставлено»). */
  onRetry: (nonce: string) => void
  /** Выбросить неотправленное сообщение вместе с черновиком. */
  onDiscard: (nonce: string) => void
  /** Карточка приглашения на сервер (см. ChatMessageBase.server_invite) —
   * только у диалогов/групп, у серверных сообщений её не бывает. */
  onAcceptServerInvite?: (inviteId: number) => void
  onDeclineServerInvite?: (inviteId: number) => void
  onOpenInvitedServer?: (serverId: number) => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Какому сообщению сейчас выбирают реакцию: id + якорь для пикера.
  const [reactionPicker, setReactionPicker] = useState<{
    messageId: number
    anchor: EmojiPickerAnchor
  } | null>(null)
  // Панель действий (реакции/ответ/редактировать/удалить) на десктопе
  // видна по :hover — на тач-устройстве такого нет вообще, а показывать её
  // сразу под КАЖДЫМ сообщением слишком шумно. Двойной тап по конкретному
  // сообщению открывает панель только для него; повторный двойной тап —
  // либо по нему же, либо по другому — закрывает/переключает.
  const [mobileActiveKey, setMobileActiveKey] = useState<string | number | null>(null)

  // Автопрокрутка вниз — только если мы и так стояли внизу. Раньше список
  // прыгал к последнему сообщению безусловно, и читать историю во время
  // живой переписки было невозможно: каждое чужое сообщение утаскивало вниз.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 150) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const confirmDelete = (m: ChatMessageBase) => {
    if (window.confirm('Удалить это сообщение? Действие необратимо.')) {
      onDelete(m.id)
    }
  }

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 && (
        <div className="message-empty">Пока нет сообщений. Напиши первым!</div>
      )}
      {messages.map((m) => {
        const isAuthor = m.author.id === currentUserId
        const pending = m.pendingNonce != null
        // Статус показываем только на СВОИХ сообщениях: чужое «доставлено»
        // ни о чём не говорит. У подтверждённого сообщения собственного
        // статуса уже нет — оно приехало с сервера обычным message_create,
        // а сам факт этого и означает «доставлено».
        const status: DeliveryStatus | null = m.deliveryStatus
          ? m.deliveryStatus
          : isAuthor
            ? 'delivered'
            : null
        const rowKey = m.pendingNonce ?? m.id
        return (
          <div
            key={rowKey}
            className={`message-row ${editingId === m.id ? 'editing' : ''} ${
              pending ? 'message-pending' : ''
            } ${m.deliveryStatus === 'failed' ? 'message-failed' : ''} ${
              mobileActiveKey === rowKey ? 'mobile-actions-active' : ''
            }`}
            onDoubleClick={() => setMobileActiveKey((prev) => (prev === rowKey ? null : rowKey))}
          >
            <button
              type="button"
              className="avatar-trigger"
              onClick={(e) => onOpenProfile(m.author, e)}
            >
              <Avatar
                name={m.author.username}
                color={m.author.avatar_color}
                image={m.author.avatar_image}
                size={40}
              />
            </button>
            <div className="message-body">
              {m.reply_to && (
                <div className="message-reply-quote">
                  <span className="message-reply-author">{m.reply_to.author.username}</span>
                  <span className="message-reply-content">{m.reply_to.content}</span>
                </div>
              )}
              <div className="message-meta">
                <span
                  className="message-author profile-trigger-name"
                  onClick={(e) => onOpenProfile(m.author, e)}
                >
                  {m.author.username}
                </span>
                <span className="message-time">{formatTime(m.created_at)}</span>
                {m.edited_at && <span className="message-edited">(изменено)</span>}
                {status && <DeliveryIndicator status={status} />}
              </div>
              {m.content && <div className="message-content">{m.content}</div>}
              <MessageAttachments attachments={m.attachments} />
              {m.server_invite && (
                <ServerInviteCard
                  invite={m.server_invite}
                  isAuthor={isAuthor}
                  onAccept={() => onAcceptServerInvite?.(m.server_invite!.id)}
                  onDecline={() => onDeclineServerInvite?.(m.server_invite!.id)}
                  onOpen={() => onOpenInvitedServer?.(m.server_invite!.server.id)}
                />
              )}
              {!pending && (
                <MessageReactions
                  reactions={m.reactions}
                  currentUserId={currentUserId}
                  onToggle={(emoji, mine) => onToggleReaction(m.id, emoji, mine)}
                  onOpenPicker={(rect) =>
                    setReactionPicker({ messageId: m.id, anchor: { rect } })
                  }
                />
              )}
              {m.deliveryStatus === 'failed' && (
                <div className="message-failed-actions">
                  <span className="message-failed-text">
                    Не доставлено — сохранено в черновики.
                  </span>
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => onRetry(m.pendingNonce!)}
                  >
                    <RotateCw size={13} /> Повторить
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-small-danger"
                    onClick={() => onDiscard(m.pendingNonce!)}
                  >
                    Удалить
                  </button>
                </div>
              )}
            </div>
            {/* У неотправленного сообщения ещё нет id на сервере — отвечать,
                реагировать и удалять его через обычные ручки нельзя; для
                него свои кнопки выше. */}
            {!pending && (
              <div className="message-actions">
                {/* Быстрые реакции прямо в ховер-меню: самый частый сценарий —
                    поставить 👍, ради него открывать пикер незачем. */}
                {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
                  <button
                    key={emoji}
                    className="message-action message-action-emoji"
                    title={`Реакция ${emoji}`}
                    onClick={() =>
                      onToggleReaction(
                        m.id,
                        emoji,
                        m.reactions.some(
                          (r) => r.emoji === emoji && r.user_ids.includes(currentUserId),
                        ),
                      )
                    }
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  className="message-action"
                  title="Добавить реакцию"
                  onClick={(e) =>
                    setReactionPicker({
                      messageId: m.id,
                      anchor: { rect: e.currentTarget.getBoundingClientRect() },
                    })
                  }
                >
                  <SmilePlus size={15} />
                </button>
                <button
                  className="message-action"
                  title="Ответить"
                  onClick={() => onReply(m)}
                >
                  <Reply size={15} />
                </button>
                {isAuthor && (
                  <button
                    className="message-action"
                    title="Изменить"
                    onClick={() => onEditRequest(m)}
                  >
                    <Pencil size={15} />
                  </button>
                )}
                {(isAuthor || canModerate) && (
                  <button
                    className="message-action message-action-danger"
                    title="Удалить"
                    onClick={() => confirmDelete(m)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />

      {reactionPicker && (
        <EmojiPicker
          anchor={reactionPicker.anchor}
          onPick={(emoji) => {
            const message = messages.find((m) => m.id === reactionPicker.messageId)
            const mine = !!message?.reactions.some(
              (r) => r.emoji === emoji && r.user_ids.includes(currentUserId),
            )
            onToggleReaction(reactionPicker.messageId, emoji, mine)
            setReactionPicker(null)
          }}
          onClose={() => setReactionPicker(null)}
        />
      )}
    </div>
  )
}
