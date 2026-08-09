import { FormEvent, useState } from 'react'
import { Loader2, MessagesSquare } from 'lucide-react'
import { useEscToClose } from '../modalStack'

/**
 * «Редактировать ветку» — переименование, и только оно. Остальные настройки
 * канала ветке недоступны по смыслу: приватность и допуски она наследует от
 * родителя, медленный режим ей ставят там же, где каналу (см. backend
 * ChannelDetail.patch — послабление для автора ровно на имя).
 *
 * Отдельная модалка, а не ChannelSettingsModal с одной вкладкой: та —
 * многовкладочный редактор канала, и открывать её ради одного поля значило бы
 * показывать человеку пустые вкладки, которые ему всё равно не дадут.
 */
export default function RenameThreadModal({
  currentName,
  onRename,
  onClose,
}: {
  currentName: string
  /** Возвращает промис: пока идёт запрос, кнопка заблокирована, ошибка
   * показывается не закрывая модалку (тот же приём, что и в
   * CreateThreadModal). */
  onRename: (name: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [name, setName] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const trimmed = name.trim()
  const unchanged = trimmed === currentName

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || unchanged || saving) return
    setSaving(true)
    setError('')
    try {
      await onRename(trimmed)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Переименовать ветку</h2>

        <form onSubmit={handleSubmit}>
          <div className="field-label">Название ветки</div>
          <div className="create-channel-name">
            <span className="create-channel-name-icon">
              <MessagesSquare size={15} />
            </span>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <div className="create-channel-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!trimmed || unchanged || saving}
            >
              {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
