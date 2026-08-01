import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { api } from '../api'
import { APP_VERSION, currentPlatform, recentErrors } from '../errorTransport'
import { useEscToClose } from '../modalStack'

const MAX_LENGTH = 4000

/** «1 ошибку», «2 ошибки», «5 ошибок» — без этого подсказка выдавала
 * «приложим 1 последних технических ошибок». */
function pluralErrors(count: number): string {
  const tens = count % 100
  const ones = count % 10
  if (tens >= 11 && tens <= 14) return `${count} последних технических ошибок`
  if (ones === 1) return `${count} последнюю техническую ошибку`
  if (ones >= 2 && ones <= 4) return `${count} последние технические ошибки`
  return `${count} последних технических ошибок`
}

/**
 * Форма «сообщить о проблеме» — то, что открывается кнопкой в правом нижнем
 * углу (см. BugReportButton).
 *
 * Два поля, а не одно: «что произошло» и «что к этому привело». Разделение
 * не косметическое — без второго вопроса человек почти всегда пишет симптом
 * («не отправляются сообщения»), а воспроизвести по симптому нечего. Прямо
 * заданный вопрос про предысторию заметно повышает шанс получить шаги.
 *
 * К отправке молча прикладываются последние пойманные у этого человека
 * ошибки (errorTransport.recentErrors) — сервер сведёт их с уже известными
 * группами. Ради этого всё и затевалось: «у меня не работает» само по себе
 * не чинится, а рядом со стектрейсом минутной давности — это готовый тикет.
 */
export default function BugReportModal({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  useEscToClose(onClose)

  const attached = recentErrors()

  const submit = async () => {
    const text = description.trim()
    if (!text) {
      setError('Опишите, что произошло.')
      return
    }
    setSending(true)
    setError('')
    try {
      await api.createBugReport({
        description: text,
        steps: steps.trim(),
        route: location.pathname,
        platform: currentPlatform(),
        app_version: APP_VERSION,
        recent_errors: attached.map((e) => ({
          kind: e.kind,
          message: e.message,
          stack: e.stack,
        })),
      })
      setSent(true)
    } catch (e) {
      // Именно inline, а не общий модал ошибки: человек уже нажал «отправить»
      // и держит в поле написанный текст — подменять экран сейчас значит
      // почти наверняка этот текст потерять.
      setError((e as Error).message || 'Не удалось отправить. Попробуйте ещё раз.')
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal bug-report-modal" onClick={(e) => e.stopPropagation()}>
          <div className="bug-report-done">
            <Check size={40} />
            <h2 className="modal-title">Спасибо, отправлено</h2>
            <p className="bug-report-hint">
              Обращение уже у нас. Отвечать в самом приложении мы пока не умеем — если
              проблема срочная, напишите ещё и в поддержку.
            </p>
            <button type="button" className="btn-primary" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal bug-report-modal" onClick={(e) => e.stopPropagation()}>
        <button className="privacy-modal-close" title="Закрыть" onClick={onClose}>
          <X size={18} />
        </button>
        <h2 className="modal-title">Сообщить о проблеме</h2>

        <label className="bug-report-label" htmlFor="bug-report-description">
          Что произошло?
        </label>
        <textarea
          id="bug-report-description"
          className="bug-report-input"
          rows={4}
          autoFocus
          maxLength={MAX_LENGTH}
          placeholder="Например: при отправке сообщения с картинкой всё зависает"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <label className="bug-report-label" htmlFor="bug-report-steps">
          Что к этому привело? <span className="bug-report-optional">необязательно</span>
        </label>
        <textarea
          id="bug-report-steps"
          className="bug-report-input"
          rows={3}
          maxLength={MAX_LENGTH}
          placeholder="Что вы делали перед этим — по шагам, если помните"
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
        />

        {/* Честно говорим, что уедет вместе с текстом. Молчаливая отправка
            стектрейсов — ровно та вещь, из-за которой такие формы перестают
            вызывать доверие. */}
        <p className="bug-report-hint">
          К обращению приложим экран, на котором вы находитесь, версию приложения
          {attached.length > 0 && <> и {pluralErrors(attached.length)}</>}.
        </p>

        {error && <p className="bug-report-error">{error}</p>}

        <div className="delete-message-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={sending}>
            Отмена
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submit()}
            disabled={sending || !description.trim()}
          >
            {sending ? 'Отправляем…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  )
}
