import { useState } from 'react'
import { Loader2, ShieldBan } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'

/** Столько же принимает backend (chat.views.ServerBans обрезает до 300) —
 * лучше не дать набрать лишнего, чем молча отрезать при сохранении. */
const REASON_MAX_LENGTH = 300

/**
 * Бан участника с причиной. ОДНА модалка на все места, откуда банят —
 * контекстное меню человека и панель модератора (см. AppShellOverlays):
 * раньше это был window.prompt, который выглядел чужеродно и не давал ни
 * показать, кого именно банишь, ни отменить действие кликом мимо.
 *
 * Причина необязательна: бан без объяснения — законное действие модератора,
 * и требовать текст значило бы провоцировать отписки вроде «.» ради того,
 * чтобы кнопка разблокировалась.
 */
export default function BanMemberModal({
  member,
  onBan,
  onClose,
}: {
  member: ProfilePopupUser
  onBan: (reason: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleBan = async () => {
    setSaving(true)
    setError('')
    try {
      await onBan(reason.trim())
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Забанить участника</h2>

        <div className="status-edit-preview">
          <Avatar
            name={member.username}
            color={member.avatar_color}
            image={member.avatar_image}
            size={56}
            userId={member.id}
          />
          <span className="user-name">
            <span className="member-name">{member.username}</span>
          </span>
        </div>

        <input
          className="status-edit-text-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleBan()}
          placeholder="Причина бана (необязательно)"
          maxLength={REASON_MAX_LENGTH}
          autoFocus
        />
        <div className="modal-hint">
          Участник потеряет членство и не сможет вернуться, пока бан не снимут.
          Причина видна модерации в списке банов.
        </div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary btn-primary-danger" onClick={handleBan} disabled={saving}>
          {saving ? <Loader2 size={15} className="spin" /> : (
            <>
              <ShieldBan size={15} /> Забанить
            </>
          )}
        </button>
        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}
