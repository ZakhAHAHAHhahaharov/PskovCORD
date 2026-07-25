import { User } from './api'

const KEY = 'pskovcord_user_cache'
// Аватар и баннер — самые тяжёлые поля профиля (data-URL, гифка баннера до
// нескольких МБ) и сейчас едут целиком в каждом ответе /api/auth/me — нет
// отдельного URL картинки, который браузер закэшировал бы сам. Кэш в
// localStorage даёт то же самое на практике: мгновенная отрисовка при
// перезагрузке страницы вместо ожидания сети, устаревает через 2 часа.
const TTL_MS = 2 * 60 * 60 * 1000

/** Последний известный профиль (включая аватар/баннер) — не старше 2 часов.
 * Используется только для мгновенной отрисовки до ответа /api/auth/me;
 * этот ответ всегда приходит следом и остаётся источником истины. */
export function loadCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const { user, ts } = JSON.parse(raw) as { user: User; ts: number }
    if (Date.now() - ts > TTL_MS) return null
    return user
  } catch {
    return null
  }
}

export function saveCachedUser(user: User): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ user, ts: Date.now() }))
  } catch {
    // localStorage переполнен (тяжёлая гифка-баннер) или недоступен — без кэша тоже работает
  }
}

export function clearCachedUser(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
