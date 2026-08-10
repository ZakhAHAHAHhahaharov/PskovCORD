/** Состояние «кто сейчас печатает» — эфемерное, целиком на клиенте.
 *
 * Событие typing от сервера (см. chat/consumers.py) приходит БЕЗ парного
 * «перестал печатать», и это осознанно: надёжной пары не выходит. Вкладку
 * закрывают, сеть отваливается, человек уходит от компьютера с открытым
 * полем ввода — и «печатает…» висело бы вечно. Поэтому у каждой отметки
 * здесь есть срок годности: печатающий, пока печатает, присылает событие
 * заново, а замолчавший гаснет сам.
 */
import { useEffect, useState } from 'react'

/** Сколько «печатает…» живёт без подтверждения.
 *
 * Заметно больше клиентского интервала отправки ниже — иначе индикатор
 * мигал бы в паузах между словами у любого, кто печатает медленнее ритма
 * ретрансляции. */
export const TYPING_TTL_MS = 9000

/** Как часто отправитель повторяет typing_start, пока продолжает набирать.
 * Не на каждую букву: это WebSocket-трафик и проверка прав в БД на каждое
 * событие (см. TYPING_THROTTLE_SEC на сервере). */
export const TYPING_THROTTLE_MS = 4000

/** Ключ «места» — канала/ветки или диалога. Пространства id у Channel и
 * Conversation независимы, поэтому голого числа мало. */
export function channelPlace(channelId: number): string {
  return `channel:${channelId}`
}
export function conversationPlace(conversationId: number): string {
  return `conversation:${conversationId}`
}

// место -> (id пользователя -> когда отметка протухнет)
const typists = new Map<string, Map<number, number>>()
const listeners = new Map<string, Set<() => void>>()

// Один общий таймер на всё приложение вместо таймера на каждую отметку:
// отметок бывает много и живут они секунды. Тикает, только пока есть кого
// гасить — молчащий чат не будит вкладку каждую секунду впустую.
let sweepTimer: ReturnType<typeof setInterval> | null = null
const SWEEP_INTERVAL_MS = 1000

function notify(place: string) {
  listeners.get(place)?.forEach((fn) => fn())
}

function sweep() {
  const now = Date.now()
  for (const [place, users] of typists) {
    let changed = false
    for (const [userId, expiresAt] of users) {
      if (expiresAt <= now) {
        users.delete(userId)
        changed = true
      }
    }
    if (users.size === 0) typists.delete(place)
    if (changed) notify(place)
  }
  if (typists.size === 0 && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** Отметить, что человек печатает здесь. Повторный вызов продлевает срок. */
export function markTyping(place: string, userId: number) {
  let users = typists.get(place)
  if (!users) {
    users = new Map()
    typists.set(place, users)
  }
  const had = users.has(userId)
  users.set(userId, Date.now() + TYPING_TTL_MS)
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
  // Продление срока уже показанному человеку ничего не меняет для интерфейса
  // — перерисовывать не на что.
  if (!had) notify(place)
}

/** Убрать отметку немедленно — человек прислал сообщение, значит допечатал.
 * Без этого «печатает…» ещё несколько секунд висело бы под уже пришедшим от
 * него сообщением. */
export function clearTyping(place: string, userId: number) {
  const users = typists.get(place)
  if (!users?.delete(userId)) return
  if (users.size === 0) typists.delete(place)
  notify(place)
}

function currentTypists(place: string): number[] {
  const users = typists.get(place)
  if (!users) return []
  const now = Date.now()
  return [...users.entries()].filter(([, exp]) => exp > now).map(([id]) => id)
}

/** Кто печатает в этом месте, кроме меня самого.
 *
 * selfId исключается здесь, а не на сервере: рассылка идёт на всю группу
 * канала (личная рассылка «всем кроме одного» стоила бы отдельного прохода
 * по участникам на каждое нажатие клавиши), поэтому своё же событие
 * возвращается и нам.
 */
export function useTypingUsers(place: string | null, selfId: number): number[] {
  const [ids, setIds] = useState<number[]>([])
  useEffect(() => {
    if (!place) {
      setIds([])
      return
    }
    const update = () => {
      const next = currentTypists(place).filter((id) => id !== selfId)
      // Сравнение по содержимому: setState новым массивом на каждый тик
      // sweep'а перерисовывал бы ленту раз в секунду вхолостую.
      setIds((prev) =>
        prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
      )
    }
    update()
    let set = listeners.get(place)
    if (!set) {
      set = new Set()
      listeners.set(place, set)
    }
    set.add(update)
    return () => {
      set!.delete(update)
      if (set!.size === 0) listeners.delete(place)
    }
  }, [place, selfId])
  return ids
}

/** Троттлинг ИСХОДЯЩИХ уведомлений: зовётся на каждое нажатие клавиши, а
 * реально отправляет не чаще TYPING_THROTTLE_MS на место. */
const lastSent = new Map<string, number>()

export function shouldSendTyping(place: string): boolean {
  const now = Date.now()
  const last = lastSent.get(place)
  if (last !== undefined && now - last < TYPING_THROTTLE_MS) return false
  lastSent.set(place, now)
  return true
}

/** Сбросить троттл — после отправки сообщения. Иначе человек, отправивший
 * сообщение и тут же начавший следующее, до конца окна не показывался бы
 * печатающим вовсе. */
export function resetTypingThrottle(place: string) {
  lastSent.delete(place)
}
