import { useId, useState } from 'react'

/**
 * Текстовое поле, которое в состоянии покоя выглядит как обычный текст (без
 * рамки/подписи) — рамка появляется только по hover (см. .inline-editable-*
 * в index.css), клик переключает в режим редактирования. Кнопки "Сохранить"
 * нет — потеря фокуса (blur) или Enter (для однострочных) коммитят
 * изменение, Escape откатывает без сохранения. Тот же паттерн, что уже
 * используется в CallTopic.tsx (click → editing-state с draft, autoFocus,
 * onBlur/Enter → commit, Escape → откат к последнему сохранённому значению
 * ПЕРЕД сбросом editing — так что даже если blur всё равно долетит после
 * Escape при размонтировании инпута, commit() увидит draft===value и не
 * пошлёт лишний запрос), только вместо WS-вызова — произвольный async
 * onSave (обычно api.updateProfile({...}) или похожий PATCH/PUT).
 */
export default function InlineEditableText({
  value,
  placeholder,
  maxLength,
  multiline = false,
  datalistOptions,
  className,
  onSave,
}: {
  value: string
  placeholder?: string
  maxLength?: number
  /** bio — textarea (несколько строк), всё остальное — обычный input. */
  multiline?: boolean
  /** Подсказки автодополнения (например, стандартные местоимения) — через
   * нативный <datalist>, второго такого паттерна в проекте пока нет. */
  datalistOptions?: string[]
  className?: string
  onSave: (value: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  const listId = useId()

  const commit = async () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed === value) return
    setError('')
    try {
      await onSave(trimmed)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (editing) {
    const commonProps = {
      className: `inline-editable-input ${className ?? ''}`,
      autoFocus: true,
      maxLength,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (!multiline && e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      },
    }
    return (
      <div className="inline-editable-wrap">
        {multiline ? (
          <textarea {...commonProps} rows={3} />
        ) : (
          <input {...commonProps} list={datalistOptions ? listId : undefined} />
        )}
        {datalistOptions && (
          <datalist id={listId}>
            {datalistOptions.map((opt) => (
              <option key={opt} value={opt} />
            ))}
          </datalist>
        )}
        {error && <div className="inline-editable-error">{error}</div>}
      </div>
    )
  }

  return (
    <div
      className={`inline-editable-display ${className ?? ''} ${!value ? 'empty' : ''}`}
      onClick={() => {
        setDraft(value)
        setEditing(true)
      }}
    >
      {value || placeholder}
    </div>
  )
}
