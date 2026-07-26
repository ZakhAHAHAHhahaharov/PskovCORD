import { useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { ChatMessageBase } from '../api'

export interface MessageInputPrefill {
  /** Меняется при каждом запросе на подстановку, даже если text тот же самый
   * (например, «Упомянуть» дважды подряд одного и того же человека) — без
   * этого второй одинаковый prefill не запустил бы эффект повторно. */
  token: number
  text: string
}

export default function MessageInput({
  channelName,
  onSend,
  replyTarget,
  onCancelReply,
  editTarget,
  onSaveEdit,
  onCancelEdit,
  hash = true,
  prefill,
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
  /** Внешняя подстановка текста в поле ввода — например, «Упомянуть» из
   * контекстного меню участника голосового канала (см. AppShell.handleMention). */
  prefill?: MessageInputPrefill | null
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // При входе в режим редактирования подставляем текущий текст сообщения.
  useEffect(() => {
    if (editTarget) setValue(editTarget.content)
  }, [editTarget])

  useEffect(() => {
    if (!prefill) return
    setValue(prefill.text)
    inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.token])

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
          ref={inputRef}
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
