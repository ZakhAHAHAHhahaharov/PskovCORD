import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { User } from '../api'
import { useEscToClose } from '../modalStack'
import { useNickname } from '../nicknames'
import Avatar from './Avatar'

const NICKNAME_MAX_LENGTH = 64

/**
 * «Добавить никнейм друга» из контекстного меню строки друга (см.
 * FriendContextMenu).
 *
 * Никнейм односторонний и приватный — его вижу только я, и человеку об этом
 * ничего не приходит (тот же принцип, что у приватной заметки в карточке
 * профиля). Пустое поле = снять никнейм: отдельной кнопки «убрать» нет, она
 * дублировала бы «стереть и сохранить».
 */
export default function FriendNicknameModal({
  friend,
  onSave,
  onClose,
}: {
  friend: User
  /** Сохранение уже обновило общий стор — модалка только показывает ошибку. */
  onSave: (nickname: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const current = useNickname(friend.id)
  const [value, setValue] = useState(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(value.trim())
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const preview = value.trim()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Никнейм друга</h2>

        <div className="status-edit-preview">
          <Avatar
            name={friend.username}
            color={friend.avatar_color}
            image={friend.avatar_image}
            size={56}
            userId={friend.id}
            showStatus
          />
          {/* Превью ровно в той форме, в какой имя будет выглядеть в списках:
              никнейм плюс подпись с настоящим ником (см. UserName). */}
          <span className="user-name">
            <span className="member-name">{preview || friend.username}</span>
            {preview && <span className="user-name-original">{friend.username}*</span>}
          </span>
        </div>

        <input
          className="status-edit-text-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
          placeholder={`Как называть ${friend.username}`}
          maxLength={NICKNAME_MAX_LENGTH}
          autoFocus
        />
        <div className="modal-hint">
          Никнейм видите только вы. Пустое поле уберёт его.
        </div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
        </button>
        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}
