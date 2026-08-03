/**
 * Реестр стикеров — наборы и карта id -> стикер, живущая вне React.
 *
 * Устроен как customEmoji.ts и ровно по той же причине: в протоколе едет
 * только id (токен "<sticker:42>" внутри текста сообщения, см. backend
 * chat/emoji.py STICKER_TOKEN_RE), а что он означает — знает этот модуль.
 *
 * Отличие от эмодзи одно, зато существенное: вкладка пикера здесь — НАБОР
 * (StickerPack), а не сервер. Набор бывает базовым (server === null): он
 * ничей, виден всем и всегда, и удалять из него нельзя никому. Поэтому
 * «могу ли я тут управлять» считается не по набору, а по его серверу — см.
 * canManagePack.
 *
 * Наполняется теми же тремя путями, что и реестр эмодзи:
 *   1. loadMyStickers() на старте — /api/stickers;
 *   2. событием server_stickers по WebSocket — когда на сервере добавили или
 *      удалили стикер;
 *   3. resolve() по требованию — для стикеров с ЧУЖИХ серверов, встреченных в
 *      присланном сообщении.
 */
import { useSyncExternalStore } from 'react'
import { Sticker, StickerPack, api } from './api'

const byId = new Map<number, Sticker>()
// Наборы в порядке показа. Отдельно от byId, потому что byId содержит ещё и
// подтянутые resolve'ом чужие стикеры, которых в пикере быть не должно:
// отправить их всё равно нельзя (backend отклонит, см. usable_sticker_ids).
let packs: StickerPack[] = []

let version = 0
const listeners = new Set<() => void>()

function notify() {
  version += 1
  listeners.forEach((l) => l())
}

function index(list: Sticker[]) {
  for (const sticker of list) byId.set(sticker.id, sticker)
}

/** Базовые наборы первыми, дальше серверные — так же, как их отдаёт бэкенд
 * (sort_order), но порядок не должен зависеть от того, чем именно ответил
 * сервер: наборы приезжают ещё и порознь, событием server_stickers. */
function sortPacks(list: StickerPack[]): StickerPack[] {
  return [...list].sort(
    (a, b) =>
      Number(a.server !== null) - Number(b.server !== null) ||
      a.sort_order - b.sort_order ||
      a.name.localeCompare(b.name) ||
      a.id - b.id,
  )
}

// resolve() копит id и уходит одним запросом на следующем тике — см. тот же
// приём в customEmoji.ts, там подробно, зачем.
const pendingResolve = new Set<number>()
const missing = new Set<number>()
let resolveTimer: ReturnType<typeof setTimeout> | null = null

async function flushResolve() {
  resolveTimer = null
  const ids = [...pendingResolve]
  pendingResolve.clear()
  if (ids.length === 0) return
  try {
    const found = await api.resolveStickers(ids)
    index(found)
    const foundIds = new Set(found.map((s) => s.id))
    for (const id of ids) if (!foundIds.has(id)) missing.add(id)
    if (found.length > 0) notify()
  } catch {
    // Молча: неотрисованный стикер — не повод показывать ошибку поверх чата.
  }
}

export const stickerStore = {
  get(id: number): Sticker | undefined {
    return byId.get(id)
  },

  /** Стикер по id; если его нет — ставит в очередь на дозагрузку и возвращает
   * undefined. Звать можно прямо из рендера. */
  lookup(id: number): Sticker | undefined {
    const found = byId.get(id)
    if (found || missing.has(id)) return found
    pendingResolve.add(id)
    if (resolveTimer === null) resolveTimer = setTimeout(flushResolve, 0)
    return undefined
  },

  /** Наборы для пикера. Пустые не показываем — вкладка, за которой ничего
   * нет, только занимала бы место в ленте. */
  getPacks(): StickerPack[] {
    return packs.filter((pack) => pack.stickers.length > 0)
  },

  /** Ответ /api/stickers целиком. */
  setMine(list: StickerPack[]) {
    packs = sortPacks(list)
    for (const pack of packs) index(pack.stickers)
    notify()
  },

  /** Событие server_stickers: сервер прислал СВОИ наборы целиком. Базовые и
   * наборы других серверов не трогаем — они в этом сообщении не участвовали.
   * Именно замена всех наборов сервера, а не правка по одному: набор мог не
   * только пополниться, но и исчезнуть целиком (последний стикер удалили — см.
   * backend ServerStickerDetail.delete). */
  setServerPacks(serverId: number, list: StickerPack[]) {
    for (const pack of list) index(pack.stickers)
    packs = sortPacks([...packs.filter((p) => p.server !== serverId), ...list])
    notify()
  },

  /** Забыть всё — при выходе из аккаунта: наборы следующего пользователя
   * другие, а id глобальны и молча совпали бы. */
  clear() {
    byId.clear()
    packs = []
    missing.clear()
    pendingResolve.clear()
    notify()
  },

  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getVersion: () => version,
}

/** Загрузить мои наборы. Зовётся один раз на старте сессии (см. AppShell). */
export async function loadMyStickers(): Promise<void> {
  try {
    stickerStore.setMine(await api.myStickers())
  } catch {
    // Молча — без стикеров чат полностью работоспособен.
  }
}

/** Перерисовать компонент при любом изменении реестра. */
export function useStickerVersion(): number {
  return useSyncExternalStore(stickerStore.subscribe, stickerStore.getVersion)
}

/** Наборы для пикера, с подпиской на изменения. */
export function useStickerPacks(): StickerPack[] {
  useStickerVersion()
  return stickerStore.getPacks()
}
