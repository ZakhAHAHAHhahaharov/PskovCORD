/** Системные уведомления — когда вкладка не на виду.
 *
 * До этого модуля пропущенное сообщение можно было увидеть только вернувшись
 * во вкладку: уровни уведомлений у серверов/каналов и заглушение уже были
 * (см. shouldNotifyForChannel), но доставлять их было некуда.
 *
 * Web Push сознательно НЕ используется: он требует service worker'а, пары
 * VAPID-ключей, хранения подписок на бэкенде и работает только по HTTPS —
 * а окупалось бы это ровно одним сценарием «вкладка закрыта совсем».
 * Notification API покрывает то, ради чего всё затевалось (свёрнутое окно,
 * фоновая вкладка, второй монитор), и не стоит ничего.
 */
import { EMOJI_TOKEN_RE, STICKER_TOKEN_RE } from './emoji'
import { playNotificationSound } from './sounds'

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

export function notificationSupport(): NotificationPermissionState {
  // В Electron/WebView Notification может отсутствовать вовсе.
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as NotificationPermissionState
}

/** Спросить разрешение. Зовётся ТОЛЬКО из настроек по явному клику: браузеры
 * прячут запрос, пришедший без жеста пользователя, а «Блокировать» на первой
 * секунде знакомства отзывается потом через настройки сайта, куда никто не
 * ходит. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return (await Notification.requestPermission()) as NotificationPermissionState
  } catch {
    return Notification.permission as NotificationPermissionState
  }
}

/** Иконка уведомления — тот же favicon, что и у вкладки.
 *
 * Абсолютный URL от текущего origin, а не относительный: уведомление рисует
 * сама ОС, и относительный путь ей разрешать не от чего. Набор favicon'ов
 * подменяемый (см. core.models.Favicon), поэтому берём стабильный маршрут, а
 * не файл из сборки. */
function iconUrl(): string {
  try {
    return new URL('/api/favicon/icon-192x192.png', location.origin).href
  } catch {
    return ''
  }
}

// Последнее показанное уведомление на «место» (канал/диалог). Нужно, чтобы
// десять сообщений подряд из одного канала не выложили десять карточек в
// системный центр уведомлений: следующее заменяет предыдущее по tag.
const lastShown = new Map<string, Notification>()

/** Сколько уведомление висит, если ОС не убирает его сама. Windows и часть
 * Linux-окружений держат их до клика — а стопка вчерашних сообщений в углу
 * экрана никому не нужна. */
const AUTO_CLOSE_MS = 8000

export interface NotifyOptions {
  title: string
  body: string
  /** Ключ «места» — все уведомления одного канала/диалога заменяют друг
   * друга, а не копятся стопкой. */
  tag: string
  /** Куда перейти по клику. */
  onClick: () => void
  withSound: boolean
}

/** Показать уведомление, если оно сейчас уместно.
 *
 * Молча ничего не делает, когда вкладка на виду: человек и так смотрит в
 * приложение, непрочитанное ему покажет обычная пилюля в сайдбаре, а
 * системная карточка поверх окна, в которое ты и так смотришь, — это шум.
 */
export function notify(opts: NotifyOptions): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible') return

  if (opts.withSound) playNotificationSound()

  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      icon: iconUrl(),
      tag: opts.tag,
      // Сообщение — не событие, требующее решения: гасим само.
      requireInteraction: false,
    })
    n.onclick = () => {
      // Поднять окно приложения поверх остальных. Без этого клик по
      // уведомлению переключал бы канал в окне, которое так и осталось за
      // чужим — то есть внешне не делал ничего.
      window.focus()
      n.close()
      opts.onClick()
    }
    // Предыдущее по тому же tag браузер заменяет сам, но в закрытии оно всё
    // равно нуждается: у заменённого объекта остаётся живой onclick.
    lastShown.get(opts.tag)?.close()
    lastShown.set(opts.tag, n)
    setTimeout(() => {
      n.close()
      if (lastShown.get(opts.tag) === n) lastShown.delete(opts.tag)
    }, AUTO_CLOSE_MS)
  } catch {
    // Notification конструктор бросает на части мобильных браузеров (там
    // уведомления умеет только service worker). Уведомление — не то, ради
    // чего стоит ронять обработку сообщения.
  }
}

/** Текст сообщения для карточки уведомления.
 *
 * Сырой content содержит служебные токены кастомных эмодзи «<:кот:12>» и
 * стикеров «<sticker:7>» (см. web/src/emoji.ts): в ленте их разбирает
 * разметка, а в системную карточку они уехали бы как есть. Упоминания
 * трогать не нужно — они здесь обычный текст «@Ник», без разметки вовсе
 * (см. web/src/mentions.ts).
 */
export function notificationBody(content: string, attachmentCount: number): string {
  let text = content
    // Группы EMOJI_TOKEN_RE: (a?) — анимированный ли, (имя), (id).
    .replace(EMOJI_TOKEN_RE, (_m, _animated, name) => `:${name}:`)
    .replace(STICKER_TOKEN_RE, '')
    .trim()
  if (!text && attachmentCount > 0) {
    text = attachmentCount === 1 ? 'Вложение' : `Вложений: ${attachmentCount}`
  }
  if (!text) text = 'Сообщение'
  // Системная карточка всё равно обрежет длинный текст, но сделает это молча
  // и по-разному в разных ОС — лучше показать явное многоточие.
  return text.length > 180 ? `${text.slice(0, 180)}…` : text
}
