/**
 * Никнеймы друзей — имена, которые Я дал другим людям (см. backend
 * chat.models.FriendNickname). Односторонние и приватные: их вижу только я,
 * объекту никакого сигнала не уходит.
 *
 * Стор устроен так же, как presence.ts: карта user_id -> никнейм живёт вне
 * React и наполняется одним запросом на старте (/api/nicknames). Причина та
 * же — подменённое имя нужно ВЕЗДЕ, где рисуется ник (строка друга, список
 * диалогов, шапка чата, лента сообщений, карточка профиля), и таскать его
 * полем в UserSerializer, который едет в каждом сообщении, ради почти всегда
 * пустой строки не стоит.
 */
import { useSyncExternalStore } from 'react'

const nicknames = new Map<number, string>()
const listeners = new Map<number, Set<() => void>>()
// Отдельная «версия» карты для подписчиков, которым нужен не конкретный
// человек, а факт любого изменения (список друзей пересобирает порядок и
// заголовки). Без неё такому подписчику пришлось бы подписываться на каждого
// друга по отдельности.
let version = 0
const globalListeners = new Set<() => void>()

function notify(userId: number) {
  version += 1
  listeners.get(userId)?.forEach((l) => l())
  globalListeners.forEach((l) => l())
}

export const nicknameStore = {
  /** Пустая строка — никнейма нет. */
  get(userId: number): string {
    return nicknames.get(userId) ?? ''
  },

  set(userId: number, nickname: string) {
    const value = nickname.trim()
    if (nicknameStore.get(userId) === value) return
    if (value) nicknames.set(userId, value)
    else nicknames.delete(userId)
    notify(userId)
  },

  merge(entries: { user_id: number; nickname: string }[]) {
    for (const entry of entries) nicknameStore.set(entry.user_id, entry.nickname)
  },

  subscribe(userId: number, listener: () => void) {
    let set = listeners.get(userId)
    if (!set) {
      set = new Set()
      listeners.set(userId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) listeners.delete(userId)
    }
  },

  subscribeAll(listener: () => void) {
    globalListeners.add(listener)
    return () => {
      globalListeners.delete(listener)
    }
  },

  getVersion: () => version,
}

/** Никнейм конкретного человека («» — не задан) с подпиской на его изменения. */
export function useNickname(userId: number | undefined): string {
  return useSyncExternalStore(
    (listener) => (userId ? nicknameStore.subscribe(userId, listener) : () => {}),
    () => (userId ? nicknameStore.get(userId) : ''),
  )
}

/** Для списков, которые перестраиваются от ЛЮБОГО изменения карты. */
export function useNicknamesVersion(): number {
  return useSyncExternalStore(nicknameStore.subscribeAll, nicknameStore.getVersion)
}

/** Как звать человека в интерфейсе: мой никнейм, иначе display_name, иначе ник.
 *
 * Никнейм бьёт display_name намеренно: display_name человек выбирает себе сам,
 * а никнейм — это то, как ЕГО решил называть я, и смысл фичи ровно в том,
 * чтобы моё название побеждало.
 */
export function displayNameOf(
  user: { id: number; username: string; display_name?: string },
): string {
  return nicknameStore.get(user.id) || user.display_name || user.username
}

/** Что подписывать справа от подменённого имени — «настоящий» ник в форме
 * `username*`. Пусто, если никнейма нет: подписывать нечего, имя и так своё. */
export function originalNameMark(
  user: { id: number; username: string },
): string {
  return nicknameStore.get(user.id) ? `${user.username}*` : ''
}
