import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Member } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

const NICKNAME_MAX_LENGTH = 100

/**
 * «Никнейм на сервере» из контекстного меню участника (см.
 * ParticipantContextMenu) и из своего профиля на сервере.
 *
 * В отличие от FriendNicknameModal этот никнейм ПУБЛИЧНЫЙ: он лежит на
 * Membership и виден всем участникам сервера, а не только тому, кто его
 * поставил. Своё имя меняет право change_nickname, чужое — manage_nicknames
 * (см. backend chat.views.ServerMemberNickname). Пустое поле = убрать
 * никнейм: отдельная кнопка «убрать» дублировала бы «стереть и сохранить».
 */
export default function ServerNicknameModal({
  member,
  isSelf,
  onSave,
  onClose,
}: {
  member: Member
  /** Меняем себе — от этого зависит только текст подсказки. */
  isSelf: boolean
  onSave: (nickname: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [value, setValue] = useState(member.server_nickname)
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
        <h2 className="modal-title">Никнейм на сервере</h2>

        <div className="status-edit-preview">
          <Avatar
            name={member.username}
            color={member.avatar_color}
            image={member.avatar_image}
            size={56}
            userId={member.id}
            showStatus
          />
          <span className="user-name">
            <span className="member-name">{preview || member.username}</span>
          </span>
        </div>

        <input
          className="status-edit-text-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
          placeholder={`Как называть ${member.username} на этом сервере`}
          maxLength={NICKNAME_MAX_LENGTH}
          autoFocus
        />
        <div className="modal-hint">
          {isSelf
            ? 'Так вас будут видеть все участники этого сервера. Пустое поле уберёт никнейм.'
            : 'Никнейм увидят все участники этого сервера. Пустое поле уберёт его.'}
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
