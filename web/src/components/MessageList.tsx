import { useEffect, useRef, useState } from 'react'
import { Message } from '../api'
import Avatar from './Avatar'

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
  onDelete,
  onEdit,
  onReply,
}: {
  messages: Message[]
  currentUserId: number
  /** Владелец сервера — может удалять чужие сообщения (но не редактировать). */
  canModerate: boolean
  onDelete: (messageId: number) => void
  onEdit: (messageId: number, content: string) => void
  onReply: (message: Message) => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const startEdit = (m: Message) => {
    setEditingId(m.id)
    setEditDraft(m.content)
  }

  const commitEdit = (m: Message) => {
    const trimmed = editDraft.trim()
    setEditingId(null)
    if (trimmed && trimmed !== m.content) onEdit(m.id, trimmed)
  }

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="message-empty">Пока нет сообщений. Напиши первым!</div>
      )}
      {messages.map((m) => {
        const isAuthor = m.author.id === currentUserId
        const isEditing = editingId === m.id
        return (
          <div key={m.id} className="message-row">
            <Avatar name={m.author.username} color={m.author.avatar_color} size={40} />
            <div className="message-body">
              {m.reply_to && (
                <div className="message-reply-quote">
                  <span className="message-reply-author">{m.reply_to.author.username}</span>
                  <span className="message-reply-content">{m.reply_to.content}</span>
                </div>
              )}
              <div className="message-meta">
                <span className="message-author">{m.author.username}</span>
                <span className="message-time">{formatTime(m.created_at)}</span>
                {m.edited_at && <span className="message-edited">(изменено)</span>}
              </div>
              {isEditing ? (
                <input
                  className="message-edit-input"
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={() => commitEdit(m)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(m)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <div className="message-content">{m.content}</div>
              )}
            </div>
            <div className="message-actions">
              <button
                className="message-action"
                title="Ответить"
                onClick={() => onReply(m)}
              >
                ↩️
              </button>
              {isAuthor && (
                <button
                  className="message-action"
                  title="Изменить"
                  onClick={() => startEdit(m)}
                >
                  ✏️
                </button>
              )}
              {(isAuthor || canModerate) && (
                <button
                  className="message-action"
                  title="Удалить"
                  onClick={() => onDelete(m.id)}
                >
                  🗑️
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
