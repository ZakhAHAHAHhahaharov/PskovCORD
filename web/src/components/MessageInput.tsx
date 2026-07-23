import { useState } from 'react'
import { Message } from '../api'

export default function MessageInput({
  channelName,
  onSend,
  replyTarget,
  onCancelReply,
}: {
  channelName: string
  onSend: (content: string) => void
  replyTarget: Message | null
  onCancelReply: () => void
}) {
  const [value, setValue] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const content = value.trim()
    if (!content) return
    onSend(content)
    setValue('')
  }

  return (
    <div className="message-input-wrap">
      {replyTarget && (
        <div className="reply-banner">
          <span className="reply-banner-text">
            Ответ пользователю <b>{replyTarget.author.username}</b>: {replyTarget.content}
          </span>
          <button className="reply-banner-cancel" title="Отменить ответ" onClick={onCancelReply}>
            ✕
          </button>
        </div>
      )}
      <form className="message-input" onSubmit={submit}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Написать в #${channelName}`}
        />
      </form>
    </div>
  )
}
