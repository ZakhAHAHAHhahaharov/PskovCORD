import { useEffect, useRef } from 'react'
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
}: {
  messages: Message[]
  currentUserId: number
  /** Владелец сервера — может удалять чужие сообщения. */
  canModerate: boolean
  onDelete: (messageId: number) => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="message-empty">Пока нет сообщений. Напиши первым!</div>
      )}
      {messages.map((m) => {
        const isAuthor = m.author.id === currentUserId
        return (
          <div key={m.id} className="message-row">
            <Avatar name={m.author.username} color={m.author.avatar_color} size={40} />
            <div className="message-body">
              <div className="message-meta">
                <span className="message-author">{m.author.username}</span>
                <span className="message-time">{formatTime(m.created_at)}</span>
              </div>
              <div className="message-content">{m.content}</div>
            </div>
            {(isAuthor || canModerate) && (
              <div className="message-actions">
                <button
                  className="message-action"
                  title="Удалить"
                  onClick={() => onDelete(m.id)}
                >
                  🗑️
                </button>
              </div>
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
