import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard'
import Avatar from './Avatar'
import StatusBubble from './StatusBubble'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'
import UnsavedChangesNudge from './UnsavedChangesNudge'

const TEXT_MAX_LENGTH = 64

/**
 * Редактор "облачка" статуса — отдельная модалка (как у баннера, см.
 * BannerEditorModal), а не инлайн-редактирование прямо в облачке: эмодзи и
 * текст — два разных поля, а на самом облачке место для одного лишь
 * текстового инпута. В отличие от остальных полей карточки (автосохранение
 * по blur/закрытию), здесь ЯВНАЯ кнопка «Сохранить» — закрытие крестиком/
 * кликом мимо/Esc отменяет черновик без сохранения.
 */
export default function StatusEditModal({
  currentEmoji,
  currentText,
  username,
  avatarColor,
  avatarImage,
  onSave,
  onClose,
}: {
  currentEmoji: string
  currentText: string
  username: string
  avatarColor: string
  avatarImage: string
  onSave: (emoji: string, text: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [emoji, setEmoji] = useState(currentEmoji)
  const [text, setText] = useState(currentText)
  const [emojiAnchor, setEmojiAnchor] = useState<EmojiPickerAnchor | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(emoji, text.trim())
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const isDirty = emoji !== currentEmoji || text !== currentText
  const { modalRef, showNudge, handleOverlayClick } = useUnsavedChangesGuard(isDirty, onClose)
  const handleDiscard = () => {
    setEmoji(currentEmoji)
    setText(currentText)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="unsaved-guard-stack">
      <div className="modal status-edit-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Статус</h2>

        <div className="status-edit-preview">
          <Avatar name={username} color={avatarColor} image={avatarImage} size={56} />
          <StatusBubble emoji={emoji} text={text} placeholder="Статус появится здесь" />
        </div>

        <div className="status-edit-row">
          <button
            type="button"
            className="status-edit-emoji-btn"
            title="Выбрать эмодзи"
            onClick={(e) =>
              setEmojiAnchor((prev) =>
                prev
                  ? null
                  : { rect: e.currentTarget.getBoundingClientRect(), placement: 'below' },
              )
            }
          >
            {emoji || '🙂'}
          </button>
          <input
            className="status-edit-text-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Чем занят?"
            maxLength={TEXT_MAX_LENGTH}
            autoFocus
          />
        </div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
        </button>
        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>

        {emojiAnchor && (
          <EmojiPicker
            anchor={emojiAnchor}
            // Панель сама не закрывается после выбора (см. EmojiPicker) —
            // можно передумать и кликнуть другой эмодзи, не открывая пикер
            // заново; закроется она сама, когда курсор её покинет.
            onPick={setEmoji}
            onClose={() => setEmojiAnchor(null)}
          />
        )}
      </div>

      {showNudge && (
        <UnsavedChangesNudge onSave={handleSave} onDiscard={handleDiscard} saving={saving} />
      )}
      </div>
    </div>
  )
}
