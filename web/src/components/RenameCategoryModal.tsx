import { FormEvent, useState } from 'react'
import { Folder, Loader2 } from 'lucide-react'
import { useEscToClose } from '../modalStack'

/**
 * Одно поле — название раздела сайдбара. Служит и созданию, и
 * переименованию: форма у них буквально одна и та же, и заводить под
 * «создать» второй почти идентичный компонент незачем (отличаются заголовок,
 * подпись кнопки и то, считается ли неизменённое имя поводом заблокировать
 * отправку).
 *
 * Устроена как RenameThreadModal: тот же Esc, та же блокировка кнопки на
 * время запроса и та же ошибка, показанная без закрытия модалки — чтобы
 * набранное имя не пропало.
 */
export default function RenameCategoryModal({
  currentName,
  creating,
  onSubmit,
  onClose,
}: {
  currentName: string
  /** true — создаём новый раздел, false — переименовываем существующий. */
  creating: boolean
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [name, setName] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const trimmed = name.trim()
  // При создании «не изменилось» не бывает: пустое поле и так не отправить.
  const unchanged = !creating && trimmed === currentName

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || unchanged || saving) return
    setSaving(true)
    setError('')
    try {
      await onSubmit(trimmed)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {creating ? 'Создать раздел' : 'Переименовать раздел'}
        </h2>

        <form onSubmit={handleSubmit}>
          <div className="field-label">Название раздела</div>
          <div className="create-channel-name">
            <span className="create-channel-name-icon">
              <Folder size={15} />
            </span>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Например: Разговоры"
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
              {saving ? (
                <Loader2 size={15} className="spin" />
              ) : creating ? (
                'Создать'
              ) : (
                'Сохранить'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
