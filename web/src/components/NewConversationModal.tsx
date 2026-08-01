import { useState } from 'react'
import { KnownPerson } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

/**
 * Мульти-выбор участников для нового диалога/группы. Ровно 1 выбранный —
 * личное сообщение; 2+ — группа с опциональным именем (см. AppShell.handleCreateConversation
 * и backend chat.views.ConversationListCreate).
 */
export default function NewConversationModal({
  people,
  onClose,
  onCreate,
}: {
  people: KnownPerson[]
  onClose: () => void
  onCreate: (data: { kind: 'dm' | 'group'; userIds: number[]; name: string }) => void
}) {
  useEscToClose(onClose)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const friends = people.filter((p) => p.is_friend)

  const toggle = (id: number) => {
    setError('')
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = () => {
    if (selected.size === 0) {
      setError('Выбери хотя бы одного человека.')
      return
    }
    onCreate({
      kind: selected.size > 1 ? 'group' : 'dm',
      userIds: [...selected],
      name: name.trim(),
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Новый диалог</h2>

        {selected.size > 1 && (
          <>
            <div className="field-label">Название группы (необязательно)</div>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </>
        )}

        <div className="field-label">Кому написать</div>
        <div className="new-conversation-list">
          {friends.length === 0 && (
            <div className="home-empty">Пока никого нет — сначала добавь друзей.</div>
          )}
          {friends.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`new-conversation-row ${selected.has(p.id) ? 'active' : ''}`}
              onClick={() => toggle(p.id)}
            >
              <Avatar
                name={p.username}
                color={p.avatar_color}
                image={p.avatar_image}
                size={28}
                userId={p.id}
                showStatus
              />
              <span className="member-name">{p.username}</span>
              <span className="member-voice">друг</span>
            </button>
          ))}
        </div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={handleCreate} disabled={selected.size === 0}>
          {selected.size > 1 ? 'Создать группу' : 'Написать'}
        </button>
        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
