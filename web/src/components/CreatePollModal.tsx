import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { OutgoingPoll } from '../outbox'
import { useEscToClose } from '../modalStack'
import ToggleSwitch from './ToggleSwitch'

/** Границы совпадают с backend chat/models.py — дублируются здесь не ради
 * валидации (она всё равно на сервере), а чтобы не давать набрать заведомо
 * отказное и не резать текст молча уже после отправки. */
const MAX_QUESTION = 300
const MAX_OPTION = 100
const MIN_OPTIONS = 2
const MAX_OPTIONS = 10

/** Варианты срока. null — бессрочный: у опроса «куда идём в пятницу» срок
 * есть, а у «кто за то, чтобы переименовать канал» — нет. */
const DURATIONS: { label: string; hours: number | undefined }[] = [
  { label: 'Без срока', hours: undefined },
  { label: '1 час', hours: 1 },
  { label: '4 часа', hours: 4 },
  { label: '1 день', hours: 24 },
  { label: '3 дня', hours: 72 },
  { label: 'Неделя', hours: 168 },
]

export default function CreatePollModal({
  onClose,
  onCreate,
  isMobile,
}: {
  onClose: () => void
  onCreate: (poll: OutgoingPoll) => void
  isMobile: boolean
}) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [multiple, setMultiple] = useState(false)
  const [durationHours, setDurationHours] = useState<number | undefined>(undefined)

  useEscToClose(onClose)

  const setOption = (index: number, value: string) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)))

  const addOption = () =>
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, '']))

  const removeOption = (index: number) =>
    // Ниже MIN_OPTIONS не опускаемся: опрос с одним вариантом — не опрос.
    setOptions((prev) =>
      prev.length <= MIN_OPTIONS ? prev : prev.filter((_, i) => i !== index),
    )

  const filled = options.map((o) => o.trim()).filter(Boolean)
  // Дубликаты сервер схлопнет молча (см. _read_poll) — предупреждаем здесь,
  // иначе человек отправит «Да/да/Нет» и получит два варианта вместо трёх,
  // не поняв почему.
  const hasDuplicates =
    new Set(filled.map((o) => o.toLowerCase())).size !== filled.length
  const canSubmit = question.trim().length > 0 && filled.length >= MIN_OPTIONS

  const submit = () => {
    if (!canSubmit) return
    onCreate({
      question: question.trim(),
      options: filled,
      multiple,
      durationHours,
    })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal create-poll-modal ${isMobile ? 'modal-mobile' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Создать опрос</h2>

        <label className="settings-field-label" htmlFor="poll-question">
          Вопрос
        </label>
        <input
          id="poll-question"
          className="field-input"
          value={question}
          maxLength={MAX_QUESTION}
          placeholder="Например: куда идём в пятницу?"
          autoFocus
          onChange={(e) => setQuestion(e.target.value)}
        />

        <div className="poll-form-options-label">Варианты</div>
        <div className="poll-form-options">
          {options.map((option, index) => (
            <div className="poll-form-option" key={index}>
              <input
                className="field-input"
                value={option}
                maxLength={MAX_OPTION}
                placeholder={`Вариант ${index + 1}`}
                onChange={(e) => setOption(index, e.target.value)}
                onKeyDown={(e) => {
                  // Enter в последнем поле добавляет следующее — набирать
                  // варианты подряд, не отрываясь на мышь.
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  if (index === options.length - 1) addOption()
                }}
              />
              <button
                type="button"
                className="poll-form-remove"
                title="Убрать вариант"
                disabled={options.length <= MIN_OPTIONS}
                onClick={() => removeOption(index)}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>

        {options.length < MAX_OPTIONS && (
          <button type="button" className="poll-form-add" onClick={addOption}>
            <Plus size={14} /> Добавить вариант
          </button>
        )}

        {hasDuplicates && (
          <div className="settings-hint settings-hint-warn">
            Одинаковые варианты будут объединены в один.
          </div>
        )}

        <div className="settings-field-header poll-form-row">
          <span className="settings-field-label">Несколько вариантов ответа</span>
          <ToggleSwitch
            checked={multiple}
            onChange={setMultiple}
            ariaLabel="Несколько вариантов ответа"
          />
        </div>

        <label className="settings-field-label" htmlFor="poll-duration">
          Завершить через
        </label>
        <select
          id="poll-duration"
          className="field-input"
          value={String(durationHours ?? '')}
          onChange={(e) =>
            setDurationHours(e.target.value ? Number(e.target.value) : undefined)
          }
        >
          {DURATIONS.map((d) => (
            <option key={d.label} value={d.hours ?? ''}>
              {d.label}
            </option>
          ))}
        </select>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="btn-primary" disabled={!canSubmit} onClick={submit}>
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
