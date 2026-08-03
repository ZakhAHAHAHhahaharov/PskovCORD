/**
 * Реестр кастомных эмодзи — карта id -> эмодзи, живущая вне React.
 *
 * Устроен как presence.ts/nicknames.ts и по той же причине: один и тот же
 * эмодзи нужен ВЕЗДЕ и по id — в ленте реакций, в тексте сообщения, в сетке
 * пикера, в редакторе сервера. Таскать полный объект в каждом сообщении и в
 * каждой реакции значило бы гонять одну и ту же картинку-метаданные по сотне
 * раз; в протоколе едет только id (см. backend chat/emoji.py), а что он
 * означает — знает этот модуль.
 *
 * Наполняется тремя путями:
 *   1. loadMine() на старте — все наборы всех моих серверов (/api/emoji);
 *   2. событием server_emoji по WebSocket — когда кто-то на сервере добавил
 *      или удалил эмодзи (см. backend _broadcast_emoji_update);
 *   3. resolve() по требованию — для эмодзи с ЧУЖИХ серверов, которые
 *      встретились в присланном сообщении. Без этого эмодзи, присланный в
 *      личку с сервера, где меня нет, остался бы вечной заглушкой.
 */
import { useSyncExternalStore } from 'react'
import { CustomEmoji, api } from './api'

const byId = new Map<number, CustomEmoji>()
// Эмодзи «моих» серверов — отдельно от byId, потому что byId содержит ещё и
// подтянутые resolve'ом чужие эмодзи, которых в пикере быть не должно:
// поставить их всё равно нельзя (backend отклонит, см. usable_ids).
const byServer = new Map<number, CustomEmoji[]>()
// Мои серверы в порядке рейла — из него берутся значок, название и порядок
// вкладок в пикере. Отдельно от byServer, потому что сервер БЕЗ эмодзи в
// /api/emoji не попадает вовсе, а добавить в него эмодзи всё равно надо.
let catalog: EmojiServer[] = []

let version = 0
const listeners = new Set<() => void>()

/** Мой сервер глазами пикера эмодзи. */
export interface EmojiServer {
  id: number
  name: string
  /** data-URL значка сервера; пусто — рисуем инициал (см. ServerRail). */
  icon: string
  /** Есть ли у меня право «Создавать средства выражения эмоций» здесь. */
  canAdd: boolean
  /** Есть ли у меня право «Управление выражениями» здесь — переименовывать и
   * удалять эмодзи сервера, в том числе загруженные другими (см. правый клик
   * по эмодзи в пикере, EmojiPicker.tsx). */
  canManage: boolean
}

/** Набор эмодзи одного сервера — вкладка в ленте наборов пикера. */
export interface CustomEmojiPack {
  server: EmojiServer
  emoji: CustomEmoji[]
}

function notify() {
  version += 1
  listeners.forEach((l) => l())
}

function index(list: CustomEmoji[]) {
  for (const emoji of list) byId.set(emoji.id, emoji)
}

/** Разложить плоский ответ /api/emoji по серверам. */
function groupByServer(list: CustomEmoji[]) {
  byServer.clear()
  for (const emoji of list) {
    const existing = byServer.get(emoji.server)
    if (existing) existing.push(emoji)
    else byServer.set(emoji.server, [emoji])
  }
}

/** Сервер, которого ещё нет в каталоге (эмодзи доехали раньше списка
 * серверов — на старте это две независимые загрузки). Название берём из
 * самого эмодзи, значок появится, когда доедет каталог. */
function fallbackServer(serverId: number): EmojiServer {
  return {
    id: serverId,
    name: byServer.get(serverId)?.[0]?.server_name ?? 'Сервер',
    icon: '',
    canAdd: false,
    canManage: false,
  }
}

// resolve() копит id и уходит одним запросом на следующем тике: экран с
// сообщениями упоминает десятки эмодзи, и поштучный запрос на каждый означал
// бы десятки round-trip'ов на одну прокрутку ленты.
const pendingResolve = new Set<number>()
// id, за которыми уже сходили и не нашли (эмодзи удалили с сервера). Без этого
// множества отрисовка такого «сироты» запрашивала бы его снова при каждом
// рендере — вечный цикл запросов на сообщение, которое никогда не починится.
const missing = new Set<number>()
let resolveTimer: ReturnType<typeof setTimeout> | null = null

async function flushResolve() {
  resolveTimer = null
  const ids = [...pendingResolve]
  pendingResolve.clear()
  if (ids.length === 0) return
  try {
    const found = await api.resolveEmoji(ids)
    index(found)
    const foundIds = new Set(found.map((e) => e.id))
    for (const id of ids) if (!foundIds.has(id)) missing.add(id)
    if (found.length > 0) notify()
  } catch {
    // Молча: неотрисованный эмодзи — не повод показывать ошибку поверх чата.
    // Заглушка на его месте уже говорит достаточно, а следующий рендер (после
    // реконнекта, например) попробует снова — в missing он не попал.
  }
}

export const customEmojiStore = {
  get(id: number): CustomEmoji | undefined {
    return byId.get(id)
  },

  /** Эмодзи по id; если его нет — ставит в очередь на дозагрузку и возвращает
   * undefined. Звать можно прямо из рендера: запрос уйдёт один на пачку. */
  lookup(id: number): CustomEmoji | undefined {
    const found = byId.get(id)
    if (found || missing.has(id)) return found
    pendingResolve.add(id)
    if (resolveTimer === null) resolveTimer = setTimeout(flushResolve, 0)
    return undefined
  },

  /** Наборы для пикера — по одному на сервер, в порядке рейла серверов.
   * Пустые наборы не показываем: вкладка, за которой ничего нет, только
   * занимала бы место в ленте (добавить эмодзи можно кнопкой «+»). */
  getPacks(): CustomEmojiPack[] {
    const ordered = catalog.length > 0
      ? catalog
      : [...byServer.keys()].map(fallbackServer)
    return ordered
      .map((server) => ({ server, emoji: byServer.get(server.id) ?? [] }))
      .filter((pack) => pack.emoji.length > 0)
  },

  /** Серверы, куда я вправе загрузить эмодзи, — цели кнопки «+». */
  getUploadTargets(): EmojiServer[] {
    return catalog.filter((server) => server.canAdd)
  },

  /** Мои серверы целиком — со значками, названиями и правами на средства
   * выражения. Нужен не только эмодзи: по нему же считается, могу ли я
   * управлять набором СТИКЕРОВ (см. stickers.ts — там своих прав нет, они
   * общие, «Управление выражениями» на сервере набора). */
  getCatalog(): EmojiServer[] {
    return catalog
  },

  /** Полный список моих эмодзи — для поиска по всем наборам разом. */
  all(): CustomEmoji[] {
    return customEmojiStore.getPacks().flatMap((pack) => pack.emoji)
  },

  /** Ответ /api/emoji целиком: и индекс по id, и наборы. */
  setMine(list: CustomEmoji[]) {
    index(list)
    groupByServer(list)
    notify()
  },

  /** Мои серверы — порядок, значки и право добавлять. Зовётся из AppShell
   * при каждом изменении списка серверов. */
  setCatalog(servers: EmojiServer[]) {
    catalog = servers
    notify()
  },

  /** Событие server_emoji: сервер прислал СВОЙ набор целиком. Остальные
   * наборы не трогаем — они в этом сообщении и не участвовали. */
  setServerEmoji(serverId: number, list: CustomEmoji[]) {
    index(list)
    // Удалённые эмодзи из byId не выбрасываем: они всё ещё стоят реакциями и
    // токенами в старых сообщениях, и там их лучше нарисовать, чем показать
    // квадрат. Из наборов (то есть из пикера) они исчезают — поставить новую
    // такую реакцию уже нельзя, backend её отклонит.
    if (list.length === 0) byServer.delete(serverId)
    else byServer.set(serverId, list)
    notify()
  },

  /** Забыть всё — при выходе из аккаунта: наборы следующего пользователя
   * другие, а id глобальны и молча совпали бы. */
  clear() {
    byId.clear()
    byServer.clear()
    catalog = []
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
export async function loadMyEmoji(): Promise<void> {
  try {
    customEmojiStore.setMine(await api.myEmoji())
  } catch {
    // Молча — без кастомных эмодзи чат полностью работоспособен, а модалка
    // с ошибкой на старте только мешала бы.
  }
}

/** Перерисовать компонент при любом изменении реестра. */
export function useCustomEmojiVersion(): number {
  return useSyncExternalStore(customEmojiStore.subscribe, customEmojiStore.getVersion)
}

/** Наборы для пикера, с подпиской на изменения. */
export function useCustomEmojiPacks(): CustomEmojiPack[] {
  useCustomEmojiVersion()
  return customEmojiStore.getPacks()
}

/** Серверы, куда я вправе загрузить эмодзи, с подпиской на изменения. */
export function useEmojiUploadTargets(): EmojiServer[] {
  useCustomEmojiVersion()
  return customEmojiStore.getUploadTargets()
}

/** Мои серверы глазами пикера — с правами на средства выражения (эмодзи и
 * стикеры сразу), с подпиской на изменения. */
export function useExpressionServers(): EmojiServer[] {
  useCustomEmojiVersion()
  return customEmojiStore.getCatalog()
}
