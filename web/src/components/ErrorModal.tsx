import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { useEscToClose } from '../modalStack'

export interface CapturedError {
  message: string
  stack: string
}

/**
 * Глобальное уведомление о непойманной ошибке (см. errorReporting.tsx —
 * ловит window.onerror/unhandledrejection + React ErrorBoundary, вместо
 * оборачивания каждого onClick по отдельности вручную). Закрывается ТОЛЬКО
 * по Esc/кнопке — намеренно без onClick на overlay, чтобы случайный клик
 * мимо не терял текст ошибки, который могут захотеть скопировать.
 */
export default function ErrorModal({
  error,
  onClose,
}: {
  error: CapturedError
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  useEscToClose(onClose)

  const copyTrace = () => {
    navigator.clipboard.writeText(error.stack).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="modal-overlay error-modal-overlay">
      <div className="modal error-modal">
        <h2 className="modal-title">Произошла ошибка</h2>
        <p className="error-modal-text">{error.message}</p>

        <button
          type="button"
          className="error-modal-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? 'Скрыть подробности' : 'Показать подробности'}
        </button>

        {expanded && (
          <div className="error-modal-trace-wrap">
            <pre className="error-modal-trace">{error.stack}</pre>
            <button type="button" className="btn-secondary error-modal-copy" onClick={copyTrace}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Скопировано' : 'Копировать трейсбэк'}
            </button>
          </div>
        )}

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
