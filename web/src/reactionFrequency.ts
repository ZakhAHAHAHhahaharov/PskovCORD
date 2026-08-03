/**
 * Какими реакциями человек пользуется чаще всего — для верхней строки
 * контекстного меню сообщения (MessageContextMenu) и для быстрого списка во
 * флайауте «Добавить реакцию».
 *
 * Персистится в localStorage (тот же приём, что userVolume.ts/hiddenNames.ts)
 * — личная статистика конкретного браузера, серверу не нужна и ни с кем не
 * синхронизируется. Ключ реакции — тот же, что и everywhere (unicode-символ
 * либо "custom:<id>", см. emoji.ts), поэтому кастомные эмодзи сервера тоже
 * попадают в список «часто используемых», если ими пользуются.
 *
 * Простой модуль без React-обвязки (в отличие от hiddenNames.ts): счётчик
 * читается один раз в момент открытия меню/флайаута — те монтируются заново
 * при каждом открытии, живой подписки на изменение не нужно.
 */

const STORAGE_KEY = 'pskovcord:reaction_frequency:v1'

/** Сколько разных ключей вообще имеет смысл хранить — top-N с запасом на
 * будущий рост лимита выдачи, не резиновый список на тысячи записей. */
const MAX_TRACKED = 50

/** Показываются, когда своей статистики ещё нет (совсем новый человек) или
 * не хватает до нужного количества — те же 4, что явно перечислены в
 * задаче, плюс несколько популярных из QUICK_REACTIONS, чтобы добрать
 * список ясельного пользователя до 8 пунктов для флайаута. */
export const DEFAULT_REACTIONS = ['💯', '🤣', '🤔', '💩', '👍', '❤️', '😂', '🔥']

type FrequencyStore = Record<string, number>

function load(): FrequencyStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(store: FrequencyStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // localStorage недоступен (приватный режим/переполнен) — статистика
    // просто не накопится, чат от этого не ломается.
  }
}

/** Отметить, что человек поставил эту реакцию — звать при ДОБАВЛЕНИИ (не при
 * снятии) из единственной точки, через которую идут все способы поставить
 * реакцию (см. MessageList.handleToggleReaction). */
export function recordReactionUse(key: string) {
  const store = load()
  store[key] = (store[key] ?? 0) + 1
  // Не даём словарю расти бесконечно: если уже под завязку и это НОВЫЙ ключ,
  // выбрасываем самый редкий — новый интерес важнее давно забытого.
  const keys = Object.keys(store)
  if (keys.length > MAX_TRACKED) {
    const rarest = keys.reduce((a, b) => (store[a] <= store[b] ? a : b))
    if (rarest !== key) delete store[rarest]
  }
  save(store)
}

/** Top-N реакций по частоте использования, дополненные DEFAULT_REACTIONS,
 * пока не наберётся нужное количество. Без дублей: реакция, которую уже
 * использовали, не появится второй раз из дефолтов. */
export function frequentReactions(limit: number): string[] {
  const store = load()
  const byFrequency = Object.keys(store).sort((a, b) => store[b] - store[a])
  const result = [...byFrequency]
  for (const fallback of DEFAULT_REACTIONS) {
    if (result.length >= limit) break
    if (!result.includes(fallback)) result.push(fallback)
  }
  return result.slice(0, limit)
}
