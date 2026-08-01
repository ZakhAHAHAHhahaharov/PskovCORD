import { FormEvent, useState } from 'react'
import { Hash, Loader2, Lock, Timer, Volume2 } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import ToggleSwitch from './ToggleSwitch'

/** Ступени медленного режима — те же, что и в меню канала (см.
 * ChannelContextMenu): между 5 с и 6 ч свободный ввод секунд был бы
 * точностью, которая никому не нужна. «Выкл.» здесь нет — за это отвечает
 * сам переключатель. */
const SLOWMODE_STEPS = [5, 10, 30, 60, 300, 900, 3600, 21600]

/** Значение по умолчанию при включении переключателя — середина шкалы была бы
 * неожиданно суровой, а 5 секунд это ровно «притормозить флуд». */
const DEFAULT_SLOWMODE_INDEX = 0

function formatSlowmode(seconds: number): string {
  if (seconds < 60) return `${seconds} с`
  if (seconds < 3600) return `${seconds / 60} мин`
  return `${seconds / 3600} ч`
}

/**
 * Создание канала — вместо прежнего window.prompt, который умел спросить
 * только имя. Медленный режим и приватность задаются сразу здесь: канал,
 * созданный открытым и настроенный через минуту, эту минуту прожил бы
 * открытым (см. backend chat.views.ChannelCreate).
 *
 * Медленный режим показывается только для текстового канала — в голосовом
 * сообщений нет, и бэк такое значение не примет (см. _parse_slowmode).
 */
export default function CreateChannelModal({
  kind,
  onCreate,
  onClose,
}: {
  kind: 'text' | 'voice'
  /** Возвращает промис — модалка держит кнопку заблокированной, пока идёт
   * запрос, и показывает ошибку, не закрываясь. */
  onCreate: (data: {
    name: string
    slowmodeSeconds: number
    isPrivate: boolean
  }) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [name, setName] = useState('')
  const [slowmodeOn, setSlowmodeOn] = useState(false)
  const [slowmodeIndex, setSlowmodeIndex] = useState(DEFAULT_SLOWMODE_INDEX)
  const [isPrivate, setIsPrivate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isText = kind === 'text'
  const trimmed = name.trim()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || saving) return
    setSaving(true)
    setError('')
    try {
      await onCreate({
        name: trimmed,
        // Голосовому каналу медленный режим не отправляем вовсе — бэк
        // отвергает ненулевое значение для не-текстового канала.
        slowmodeSeconds: isText && slowmodeOn ? SLOWMODE_STEPS[slowmodeIndex] : 0,
        isPrivate,
      })
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
          {isText ? 'Создать текстовый канал' : 'Создать голосовой канал'}
        </h2>

        <form onSubmit={handleSubmit}>
          <div className="field-label">Название канала</div>
          <div className="create-channel-name">
            <span className="create-channel-name-icon">
              {isText ? <Hash size={15} /> : <Volume2 size={15} />}
            </span>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isText ? 'новый-канал' : 'Новый канал'}
              maxLength={100}
              autoFocus
            />
          </div>

          {isText && (
            <div className="create-channel-option">
              <div className="create-channel-option-head">
                <span className="create-channel-option-label">
                  <Timer size={15} /> Медленный режим
                </span>
                <ToggleSwitch
                  checked={slowmodeOn}
                  onChange={setSlowmodeOn}
                  ariaLabel="Медленный режим"
                />
              </div>
              <div className="create-channel-option-hint">
                Участники смогут писать не чаще одного сообщения в выбранный
                промежуток. Право «Обход медленного режима» его снимает.
              </div>
              {slowmodeOn && (
                <div className="create-channel-slider">
                  <input
                    type="range"
                    min={0}
                    max={SLOWMODE_STEPS.length - 1}
                    step={1}
                    value={slowmodeIndex}
                    onChange={(e) => setSlowmodeIndex(Number(e.target.value))}
                    aria-label="Промежуток медленного режима"
                  />
                  <span className="create-channel-slider-value">
                    {formatSlowmode(SLOWMODE_STEPS[slowmodeIndex])}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="create-channel-option">
            <div className="create-channel-option-head">
              <span className="create-channel-option-label">
                <Lock size={15} /> Приватный канал
              </span>
              <ToggleSwitch
                checked={isPrivate}
                onChange={setIsPrivate}
                ariaLabel="Приватный канал"
              />
            </div>
            <div className="create-channel-option-hint">
              {isPrivate
                ? 'Канал увидят только те, кто управляет каналами. Открыть его нужным ролям можно потом — правым кликом по каналу.'
                : 'Канал увидят все, у кого есть право «Просматривать каналы».'}
            </div>
          </div>

          {error && <div className="login-error">{error}</div>}

          <div className="create-channel-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={!trimmed || saving}>
              {saving ? <Loader2 size={15} className="spin" /> : 'Создать канал'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
