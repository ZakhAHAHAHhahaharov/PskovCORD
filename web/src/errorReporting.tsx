import { Component, createContext, ErrorInfo, ReactNode, useContext, useEffect, useState } from 'react'
import ErrorModal, { CapturedError } from './components/ErrorModal'
import { ErrorKind, reportError } from './errorTransport'

function toCaptured(err: unknown): CapturedError {
  if (err instanceof Error) {
    return { message: err.message || 'Ошибка без сообщения', stack: err.stack || err.message }
  }
  const text = typeof err === 'string' ? err : JSON.stringify(err)
  return { message: text || 'Неизвестная ошибка', stack: text }
}

/** Показать модал И отправить отчёт. Одно место на оба действия, чтобы
 * добавленная позже точка перехвата не начала делать только половину. */
function capture(
  err: unknown,
  kind: ErrorKind,
  setError: (e: CapturedError) => void,
) {
  const captured = toCaptured(err)
  setError(captured)
  reportError({ kind, message: captured.message, stack: captured.stack })
}

const ReportErrorCtx = createContext<(err: unknown) => void>(() => {})

/** Ручной отчёт об ошибке — для мест, которые сами ловят исключение (try/
 * catch) и хотят вместо/вместе с локальным inline-текстом показать общий
 * модал с трейсбэком (например, длинная асинхронная операция, где inline-
 * текста под кнопкой недостаточно). Необязателен — обычные необработанные
 * ошибки и так долетают через window.onerror/unhandledrejection ниже. */
export const useReportError = () => useContext(ReportErrorCtx)

/**
 * Ловит ошибки колбэков кнопок (и вообще любые необработанные ошибки) без
 * оборачивания каждого onClick вручную по всему приложению — два глобальных
 * листенера вместо сотен точечных try/catch:
 *   - 'error' — синхронный throw внутри обработчика события (React зовёт
 *     onClick синхронно, необработанное исключение долетает досюда).
 *   - 'unhandledrejection' — async-обработчик (async () => {...}) кинул
 *     или зареджектил промис без собственного try/catch.
 * Ошибки, которые компонент уже сам ловит (подавляющее большинство кнопок с
 * серверным запросом в этом проекте — try/catch + setError inline), сюда не
 * долетают вообще: это финальная сетка только для того, что никто не поймал.
 */
export function ErrorReportingProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<CapturedError | null>(null)

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      capture(e.error ?? e.message, 'js_runtime', setError)
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      capture(e.reason, 'promise', setError)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return (
    <ReportErrorCtx.Provider value={(err) => capture(err, 'manual', setError)}>
      {children}
      {error && <ErrorModal error={error} onClose={() => setError(null)} />}
    </ReportErrorCtx.Provider>
  )
}

/** Ловит ошибки, брошенные во время РЕНДЕРА (window.onerror их не всегда
 * видит одинаково во всех браузерах) — тот же модал, что и у остального:
 * закрытие сбрасывает состояние границы, React пробует отрендерить детей
 * заново (сработает, если ошибка была случайной/временной). */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: CapturedError | null }
> {
  state: { error: CapturedError | null } = { error: null }

  static getDerivedStateFromError(err: unknown) {
    return { error: toCaptured(err) }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(err, info.componentStack)
    // Отправляем отсюда, а не из getDerivedStateFromError: тот статический и
    // обязан быть чистым (React зовёт его и в отброшенных попытках рендера).
    // К стеку подклеиваем дерево компонентов — по обычному стеку минифи-
    // цированного бандла место поломки не найти, а по нему видно сразу.
    const captured = toCaptured(err)
    reportError({
      kind: 'render',
      message: captured.message,
      stack: `${captured.stack}\n--- компоненты ---${info.componentStack}`,
    })
  }

  render() {
    if (this.state.error) {
      return <ErrorModal error={this.state.error} onClose={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}
