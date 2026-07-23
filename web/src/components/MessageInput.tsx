import { useEffect, useState } from 'react'
import { Message } from '../api'

export default function MessageInput({
  channelName,
  onSend,
  replyTarget,
  onCancelReply,
  editTarget,
  onSaveEdit,
  onCancelEdit,
}: {
  channelName: string
  onSend: (content: string) => void
  replyTarget: Message | null
  onCancelReply: () => void
  editTarget: Message | null
  onSaveEdit: (messageId: number, content: string) => void
  onCancelEdit: () => void
}) {
  const [value, setValue] = useState('')

  // При входе в режим редактирования подставляем текущий текст сообщения.
  useEffect(() => {
    if (editTarget) setValue(editTarget.content)
  }, [editTarget])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const content = value.trim()
    if (!content) return
    if (editTarget) {
      onSaveEdit(editTarget.id, content)
    } else {
      onSend(content)
    }
    setValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && editTarget) {
      onCancelEdit()
      setValue('')
    }
  }

  return (
    <div className="message-input-wrap">
      {editTarget ? (
        <div className="reply-banner edit-banner">
          <span className="reply-banner-text">✏️ Редактирование сообщения</span>
          <button className="reply-banner-cancel" title="Отменить (Esc)" onClick={onCancelEdit}>
            ✕
          </button>
        </div>
      ) : (
        replyTarget && (
          <div className="reply-banner">
            <span className="reply-banner-text">
              Ответ пользователю <b>{replyTarget.author.username}</b>: {replyTarget.content}
            </span>
            <button className="reply-banner-cancel" title="Отменить ответ" onClick={onCancelReply}>
              ✕
            </button>
          </div>
        )
      )}
      <form className="message-input" onSubmit={submit}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={editTarget ? 'Изменить сообщение…' : `Написать в #${channelName}`}
        />
      </form>
    </div>
  )
}
