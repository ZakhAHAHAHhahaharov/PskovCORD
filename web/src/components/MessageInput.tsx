import { useEffect, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { ChatMessageBase } from '../api'

export default function MessageInput({
  channelName,
  onSend,
  replyTarget,
  onCancelReply,
  editTarget,
  onSaveEdit,
  onCancelEdit,
  hash = true,
}: {
  /** Название текстового канала/собеседника/группы для плейсхолдера. */
  channelName: string
  /** "#" перед именем — только для текстовых каналов сервера; в диалогах/группах не показываем. */
  hash?: boolean
  onSend: (content: string) => void
  replyTarget: ChatMessageBase | null
  onCancelReply: () => void
  editTarget: ChatMessageBase | null
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
          <span className="reply-banner-text">
            <Pencil size={13} /> Редактирование сообщения
          </span>
          <button className="reply-banner-cancel" title="Отменить (Esc)" onClick={onCancelEdit}>
            <X size={14} />
          </button>
        </div>
      ) : (
        replyTarget && (
          <div className="reply-banner">
            <span className="reply-banner-text">
              Ответ пользователю <b>{replyTarget.author.username}</b>: {replyTarget.content}
            </span>
            <button className="reply-banner-cancel" title="Отменить ответ" onClick={onCancelReply}>
              <X size={14} />
            </button>
          </div>
        )
      )}
      <form className="message-input" onSubmit={submit}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            editTarget ? 'Изменить сообщение…' : `Написать в ${hash ? '#' : ''}${channelName}`
          }
        />
      </form>
    </div>
  )
}
