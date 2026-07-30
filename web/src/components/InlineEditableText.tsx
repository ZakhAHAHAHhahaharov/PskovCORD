import { useEffect, useId, useRef, useState } from 'react'

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
  style,
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
  /** Стиль ника (см. nameStyle.ts) — единственный текущий потребитель,
   * ProfileCardHeader.profile-card-name: выбранный эффект должен быть виден
   * сразу в самом поле ввода, а не только после сохранения. Применяется и в
   * режиме редактирования (инпут), и в режиме отображения (див ниже). */
  style?: React.CSSProperties
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

  // Сохранение при РАЗМОНТИРОВАНИИ, а не только по blur.
  //
  // blur — единственный путь сохранения, но он не наступает, когда поле
  // исчезает вместе с контейнером: клик мимо мини-профиля (MiniProfilePopup
  // закрывается по mousedown вне себя) убивал инпут до того, как браузер
  // успевал снять с него фокус, и набранная заметка о другом пользователе
  // просто пропадала — «заметки не добавляются». React blur при unmount не
  // шлёт, так что коммитим здесь сами.
  //
  // Всё через ref'ы: cleanup видит только те значения, что были на момент
  // ПОСЛЕДНЕГО рендера, а Escape и закрытие попапа приходят одним и тем же
  // событием — состояние «отменено» просто не успело бы стать стейтом.
  const latest = useRef({ editing, draft, value, onSave })
  latest.current = { editing, draft, value, onSave }
  const cancelled = useRef(false)
  useEffect(
    () => () => {
      if (cancelled.current) return
      const { editing: wasEditing, draft: lastDraft, value: lastValue, onSave: save } = latest.current
      if (!wasEditing) return
      const trimmed = lastDraft.trim()
      if (trimmed === lastValue) return
      void save(trimmed).catch(() => {
        // Показать ошибку уже негде — компонента нет. Молчим намеренно:
        // значение либо сохранилось, либо нет, и вернуться к нему можно
        // тем же полем.
      })
    },
    [],
  )

  if (editing) {
    const commonProps = {
      className: `inline-editable-input ${className ?? ''}`,
      style,
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
          // Esc в мини-профиле заодно закрывает сам попап (useEscToClose) —
          // то есть размонтирует это поле тем же событием. Флаг ставится
          // синхронно, чтобы cleanup выше не принял откат за «недосохранили».
          cancelled.current = true
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
      style={style}
      onClick={() => {
        cancelled.current = false
        setDraft(value)
        setEditing(true)
      }}
    >
      {value || placeholder}
    </div>
  )
}
