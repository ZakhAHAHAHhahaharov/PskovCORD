import { useState } from 'react'
import { useGateway } from '../gateway'

/**
 * Статус текущего разговора в голосовом канале — виден всем, но менять
 * его может только тот, кто сейчас сам в этом канале (canEdit).
 */
export default function CallTopic({
  topic,
  canEdit,
}: {
  topic: string | null
  canEdit: boolean
}) {
  const gateway = useGateway()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(topic ?? '')

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== (topic ?? '')) gateway.voiceTopicUpdate(trimmed)
  }

  if (editing) {
    return (
      <input
        className="call-topic-input"
        autoFocus
        maxLength={120}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(topic ?? '')
            setEditing(false)
          }
        }}
      />
    )
  }

  if (!topic && !canEdit) return null

  return (
    <span
      className={`call-topic ${canEdit ? 'editable' : ''}`}
      title={topic ?? undefined}
      onClick={() => {
        if (!canEdit) return
        setDraft(topic ?? '')
        setEditing(true)
      }}
    >
      {topic || 'Добавить статус…'}
    </span>
  )
}
