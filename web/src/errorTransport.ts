/**
 * Отправка отчётов об ошибках на сервер (backend: bugs.views.ErrorIngest).
 *
 * Точки перехвата ошибок в приложении уже были (см. errorReporting.tsx —
 * window.onerror, unhandledrejection и React ErrorBoundary), но всё пойманное
 * показывалось человеку и умирало вместе с вкладкой. Здесь — только транспорт.
 *
 * Три правила, которым подчинено всё в этом файле:
 *
 * 1. НИКОГДА не бросать. Исключение отсюда поймает тот самый глобальный
 *    обработчик, который нас и позвал, — получится бесконечная петля, которая
 *    положит и вкладку, и сервер. Поэтому весь путь обёрнут в try/catch, а
 *    промис глушится .catch(() => {}).
 * 2. Глушить повторы. Ошибка в цикле перерисовки даёт сотни событий в секунду;
 *    сервер такое переживёт (там свой троттл), но канал человека — нет.
 * 3. Переживать закрытие вкладки. Самые интересные ошибки — те, после которых
 *    приложение падает и вкладку закрывают; обычный fetch в этот момент
 *    отменяется вместе со страницей.
 */
import { API, getToken } from './api'

declare const __APP_VERSION__: string

export type ErrorKind =
  | 'js_runtime'
  | 'render'
  | 'promise'
  | 'api'
  | 'voice_webrtc'
  | 'websocket'
  | 'manual'

export interface ErrorPayload {
  kind: ErrorKind
  message: string
  stack?: string
}

/** Одну и ту же ошибку чаще, чем раз в столько миллисекунд, не шлём. */
const DEDUP_WINDOW_MS = 60_000
/** Потолок на вкладку. Защита от сценария, где ошибки идут не циклом, а
 * лавиной РАЗНЫХ сигнатур (например, битый ответ сервера ломает каждый
 * компонент по-своему) — дедуп такое не ловит, а слать бесконечно нельзя. */
const MAX_PER_SESSION = 50

const lastSentAt = new Map<string, number>()
let sentThisSession = 0
// Страховка от СИНХРОННОЙ петли: если что-то внутри подготовки отчёта само
// бросит, глобальный обработчик позовёт reportError повторно, не выйдя из
// первого вызова. Флаг снимается сразу по выходу из синхронной части — держать
// его на время сетевого запроса нельзя, иначе он глушил бы другие, ни в чём не
// повинные ошибки, случившиеся за те же миллисекунды.
let inReport = false

function platform(): string {
  const isMobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
  // Флаг ставит наш preload (desktop/preload.js), а не User-Agent. По UA это
  // не определить: `Electron/` есть у ЛЮБОГО приложения на Electron, и
  // веб-версия, открытая в стороннем Electron-браузере, засчитывалась бы как
  // наш десктоп — проверено вживую, именно так и произошло.
  const isOurDesktop = (window as { __PSKOVCORD_DESKTOP__?: boolean }).__PSKOVCORD_DESKTOP__
  if (isOurDesktop) return isMobile ? 'mobile_app' : 'desktop_app'
  return isMobile ? 'web_mobile' : 'web_desktop'
}

/** Ключ дедупа. Считается на клиенте и НЕ обязан совпадать с серверным
 * fingerprint: там он нужен для точной группировки, здесь — только чтобы
 * отличить «та же самая ошибка снова» от новой, и первой строки стека для
 * этого достаточно. */
function dedupKey(payload: ErrorPayload): string {
  const frame = (payload.stack || '').split('\n')[1] || ''
  return `${payload.kind}|${payload.message}|${frame.trim()}`
}

function shouldSend(payload: ErrorPayload): boolean {
  if (sentThisSession >= MAX_PER_SESSION) return false
  const key = dedupKey(payload)
  const now = Date.now()
  const previous = lastSentAt.get(key)
  if (previous !== undefined && now - previous < DEDUP_WINDOW_MS) return false
  lastSentAt.set(key, now)
  return true
}

/**
 * Отправить отчёт. Ничего не возвращает и никогда не бросает — вызывающему
 * нечего делать с результатом, а любая попытка его обработать была бы новым
 * местом, где можно упасть внутри обработчика падений.
 */
export function reportError(payload: ErrorPayload): void {
  if (inReport) return
  inReport = true
  try {
    if (!shouldSend(payload)) return
    sentThisSession += 1

    const token = getToken()
    // keepalive, а не navigator.sendBeacon: beacon переживает закрытие
    // вкладки, но не умеет слать заголовки — то есть отчёт уехал бы всегда
    // анонимным, и «ник пользователя, который встретился с ошибкой» пропал
    // бы ровно там, где он есть. fetch с keepalive даёт и то, и другое.
    void fetch(`${API}/api/errors`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        kind: payload.kind,
        message: payload.message,
        stack: payload.stack || '',
        route: location.pathname,
        platform: platform(),
        app_version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
      }),
    }).catch(() => {})
  } catch {
    // Сюда попадает только поломка самой подготовки отчёта (например,
    // JSON.stringify на структуре с циклом). Молча — см. правило 1.
  } finally {
    inReport = false
  }
}

/** Только для тестов: сбросить накопленное состояние дедупа. */
export function __resetTransportState() {
  lastSentAt.clear()
  sentThisSession = 0
  inReport = false
}
