/**
 * Онлайн-статус ЧУЖИХ пользователей — одна карта user_id -> статус на всё
 * приложение.
 *
 * Зачем отдельный стор, а не поле в каждом списке: точка статуса на аватарке
 * нужна в местах, у которых нет и не должно быть общего владельца состояния —
 * список друзей, список диалогов, пикеры «новый диалог»/«пригласить»,
 * автокомплит @упоминаний. Раньше статус ехал только в ростере сервера
 * (Member.status, см. MembersList), и во всех остальных списках взять его было
 * попросту неоткуда.
 *
 * Живёт вне React (см. outbox.ts — тот же приём): наполняется снимком с
 * /api/presence на старте и дальше капает по presence_update из WebSocket, а
 * подписчиков у него столько же, сколько аватарок на экране. Avatar подписан
 * на СВОЙ userId (см. useUserStatus), поэтому чужой presence_update не
 * перерисовывает весь список.
 *
 * Голосовые каналы намеренно НЕ пользуются этим стором: там у аватарки свой
 * язык состояний (говорит/замьючен/оглушён), и точка статуса поверх него
 * только мешает.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { EffectiveStatus } from './api'

/** Про кого ничего не знаем — offline, как и у Avatar по умолчанию. */
export const DEFAULT_STATUS: EffectiveStatus = 'offline'

const statuses = new Map<number, EffectiveStatus>()
// Подписчики раздельно по пользователям: аватарок на экране десятки, а
// presence_update приходит про ОДНОГО — общий список слушателей заставлял бы
// перерисовываться их все.
const listeners = new Map<number, Set<() => void>>()

function notify(userId: number) {
  listeners.get(userId)?.forEach((l) => l())
}

export const presenceStore = {
  get(userId: number): EffectiveStatus {
    return statuses.get(userId) ?? DEFAULT_STATUS
  },

  set(userId: number, status: EffectiveStatus) {
    if (statuses.get(userId) === status) return
    statuses.set(userId, status)
    notify(userId)
  },

  /** Снимок пачкой — /api/presence на старте и ростер сервера при загрузке. */
  merge(entries: { user_id: number; status: EffectiveStatus }[]) {
    for (const entry of entries) presenceStore.set(entry.user_id, entry.status)
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
}

/** Статус конкретного человека с подпиской на его изменения. userId 0/undefined
 * (собеседник неизвестен) — всегда offline, без подписки. */
export function useUserStatus(userId: number | undefined): EffectiveStatus {
  return useSyncExternalStore(
    (listener) => (userId ? presenceStore.subscribe(userId, listener) : () => {}),
    () => (userId ? presenceStore.get(userId) : DEFAULT_STATUS),
  )
}

/** Статусы пачки людей — для того, кто по ним ФИЛЬТРУЕТ, а не просто рисует
 * точку (подвкладка «В сети» в списке друзей). Отдельно от useUserStatus,
 * потому что фильтрация происходит в родителе, где хук на каждого человека не
 * позовёшь: их число меняется от рендера к рендеру. */
export function useUserStatuses(userIds: number[]): Map<number, EffectiveStatus> {
  // Ключ строкой — массив id каждый рендер новый, и эффект по нему самому
  // переподписывался бы бесконечно.
  const key = userIds.join(',')
  const [snapshot, setSnapshot] = useState<Map<number, EffectiveStatus>>(() => new Map())

  useEffect(() => {
    const ids = key ? key.split(',').map(Number) : []
    const refresh = () => setSnapshot(new Map(ids.map((id) => [id, presenceStore.get(id)])))
    refresh()
    const unsubscribes = ids.map((id) => presenceStore.subscribe(id, refresh))
    return () => unsubscribes.forEach((off) => off())
  }, [key])

  return snapshot
}
