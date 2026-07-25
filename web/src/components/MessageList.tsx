import { useEffect, useRef, MouseEvent as ReactMouseEvent } from 'react'
import { Reply, Pencil, Trash2 } from 'lucide-react'
import { Message } from '../api'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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
}: {
  messages: Message[]
  currentUserId: number
  /** Владелец сервера — может удалять чужие сообщения (но не редактировать). */
  canModerate: boolean
  /** id сообщения, которое сейчас редактируется внизу в композере. */
  editingId: number | null
  onDelete: (messageId: number) => void
  onEditRequest: (message: Message) => void
  onReply: (message: Message) => void
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const confirmDelete = (m: Message) => {
    if (window.confirm('Удалить это сообщение? Действие необратимо.')) {
      onDelete(m.id)
    }
  }

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="message-empty">Пока нет сообщений. Напиши первым!</div>
      )}
      {messages.map((m) => {
        const isAuthor = m.author.id === currentUserId
        return (
          <div
            key={m.id}
            className={`message-row ${editingId === m.id ? 'editing' : ''}`}
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
              </div>
              <div className="message-content">{m.content}</div>
            </div>
            <div className="message-actions">
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
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
