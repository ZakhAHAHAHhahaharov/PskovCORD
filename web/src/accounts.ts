import { UserStatus } from './api'

const KEY = 'pskovcord:known_accounts'

/** До скольки аккаунтов сразу можно держать авторизованными на одном
 * устройстве — 1 активный (обычные access/refresh, см. api.ts) + столько
 * "свёрнутых" здесь. */
export const MAX_ACCOUNTS = 4

/** "Свёрнутый" (неактивный) аккаунт — снимок профиля для отрисовки в
 * переключателе (StatusMenu) + его refresh-токен, ротируемый только в
 * момент, когда на этот аккаунт переключаются (см. auth.tsx switchAccount и
 * backend accounts.views.SwitchAccountView). Пока аккаунт активен, его
 * токены живут в обычных access/refresh ключах — сюда попадает только его
 * последний известный refresh в момент, когда с него переключились НА
 * другой аккаунт. */
export interface StoredAccount {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  status: UserStatus
  refresh: string
}

export function loadKnownAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? dedupeById(parsed) : []
  } catch {
    return []
  }
}

/** Схлопывает записи с одинаковым id, оставляя последнюю (самый свежий
 * refresh). Чинит уже испорченные хранилища: раньше «добавить аккаунт» тем
 * же самым аккаунтом, под которым уже сидишь, клало его копию в этот список,
 * и в переключателе он показывался дважды (см. auth.addAccount — там же
 * закрыта и сама причина). Заодно снимает дубликат React-ключа в списке. */
function dedupeById(accounts: StoredAccount[]): StoredAccount[] {
  const byId = new Map<number, StoredAccount>()
  for (const a of accounts) {
    if (a && typeof a.id === 'number') byId.set(a.id, a)
  }
  return [...byId.values()]
}

function saveKnownAccounts(accounts: StoredAccount[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(accounts))
  } catch {
    // localStorage недоступен/переполнен — переключатель аккаунтов молча не
    // запомнит это состояние, само приложение продолжает работать.
  }
}

/** Добавить/обновить запись — по id, без дублей. */
export function upsertKnownAccount(entry: StoredAccount, existing: StoredAccount[]): StoredAccount[] {
  const next = existing.filter((a) => a.id !== entry.id)
  next.push(entry)
  saveKnownAccounts(next)
  return next
}

export function removeKnownAccount(id: number, existing: StoredAccount[]): StoredAccount[] {
  const next = existing.filter((a) => a.id !== id)
  saveKnownAccounts(next)
  return next
}
