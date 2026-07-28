/**
 * Очередь исходящих сообщений: статус доставки, ретраи, черновики.
 *
 * Зачем вообще. `ws.send()` ничего не гарантирует: он кладёт данные в буфер
 * сокета и возвращает управление. Сокет может оборваться в тот же миг, а на
 * стороне сервера отправка может законно не состояться (нет прав, канал
 * удалили) — раньше и то, и другое выглядело одинаково: сообщение просто
 * исчезало без следа, и человек узнавал об этом, только заметив, что его
 * никто не прочитал.
 *
 * Как устроено. Каждая отправка получает nonce — метку попытки. Сообщение
 * сразу рисуется в ленте со статусом «отправляется» и ждёт эха с этим же
 * nonce (backend возвращает его в message_create, см. chat/consumers.py).
 * Пришло эхо — «доставлено». Не пришло за ACK_TIMEOUT_MS — повторная
 * отправка с ТЕМ ЖЕ nonce (сервер узнаёт попытку и не создаёт дубль).
 * Кончились попытки или пришёл явный отказ — «не доставлено», и сообщение
 * уезжает в черновики localStorage, откуда переживает перезагрузку страницы
 * и остаётся видимым с кнопками «повторить»/«удалить».
 *
 * Состояние живёт вне React (useSyncExternalStore ниже): таймеры ретраев не
 * должны умирать вместе с размонтированием компонента при переключении
 * канала — отправленное в одном канале обязано долететь, даже если смотришь
 * уже в другой.
 */
import { useSyncExternalStore } from 'react'
import { Attachment, ChatMessageBase, User } from './api'

// --- настройки (PLACEHOLDER для кастомизации) -------------------------------
// Собраны в одном объекте намеренно: это то, что захочется крутить первым —
// на плохой мобильной сети таймаут мал, а на локалке три попытки избыточны.
// Меняется здесь, в одном месте, а не по коду.
export const DELIVERY_CONFIG = {
  /** Сколько ждём эхо, прежде чем считать попытку провалившейся. */
  ackTimeoutMs: 8000,
  /** Сколько всего попыток, включая первую. 0 повторов = 1 попытка. */
  maxAttempts: 3,
  /** База экспоненциальной задержки между повторами. */
  retryBaseMs: 1500,
  /** Потолок задержки — чтобы третья попытка не ушла через минуту. */
  retryMaxMs: 10000,
  /** Сколько черновиков хранить на одну беседу/канал. Старые вытесняются:
   *  localStorage не резиновый, а бесконечная лента «не доставлено» бесполезна. */
  maxDraftsPerTarget: 20,
}

export type DeliveryStatus = 'sending' | 'delivered' | 'failed'

/** Как показывать статус. PLACEHOLDER: подписи и имена классов вынесены
 * сюда, чтобы менять вид индикатора (иконку, текст, цвет) не трогая разметку
 * MessageList. Сами иконки подставляет компонент — здесь только семантика. */
export const DELIVERY_STATUS_PRESENTATION: Record<
  DeliveryStatus,
  { label: string; className: string }
> = {
  sending: { label: 'Отправляется…', className: 'msg-status-sending' },
  delivered: { label: 'Доставлено', className: 'msg-status-delivered' },
  failed: { label: 'Не доставлено', className: 'msg-status-failed' },
}

export type OutboxTarget =
  | { kind: 'channel'; id: number }
  | { kind: 'conversation'; id: number }

export interface PendingMessage {
  nonce: string
  target: OutboxTarget
  content: string
  replyTo: number | null
  attachments: Attachment[]
  status: DeliveryStatus
  /** Сколько попыток отправки уже сделано. */
  attempt: number
  createdAt: number
  /** Причина отказа — только у failed; показывается подсказкой. */
  error?: string
}

/** Как outbox отправляет сообщение наружу. Подставляется из AppShell, чтобы
 * модуль не зависел от React-контекста gateway (см. useOutboxTransport). */
export type OutboxSend = (message: PendingMessage) => void

const DRAFTS_KEY = 'pskovcord:drafts:v1'

function targetKey(target: OutboxTarget): string {
  return `${target.kind}:${target.id}`
}

function newNonce(): string {
  // crypto.randomUUID есть везде, где работает остальное приложение
  // (WebRTC/WebSocket), но в http-контексте без secure origin его нет —
  // фолбэк нужен, иначе отправка упала бы на ровном месте.
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

// --- хранилище черновиков ---------------------------------------------------
type DraftStore = Record<string, PendingMessage[]>

function readDrafts(): DraftStore {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    return raw ? (JSON.parse(raw) as DraftStore) : {}
  } catch {
    // Битый JSON или недоступный localStorage (приватный режим) — не повод
    // ронять чат: черновики просто не переживут перезагрузку.
    return {}
  }
}

function writeDrafts(store: DraftStore) {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(store))
  } catch {
    /* переполнен или недоступен — молча живём без черновиков */
  }
}

// --- само хранилище ---------------------------------------------------------
class Outbox {
  private pending: PendingMessage[] = []
  private listeners = new Set<() => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private send: OutboxSend | null = null

  constructor() {
    // Черновики прошлой сессии сразу становятся видимыми сообщениями со
    // статусом «не доставлено» — иначе они бы existed только в localStorage,
    // о чём пользователь никак не узнал бы.
    const store = readDrafts()
    this.pending = Object.values(store).flat()
  }

  // --- подписка (useSyncExternalStore) ---
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.pending

  private emit() {
    // Новый массив на каждое изменение: useSyncExternalStore сравнивает
    // снапшоты по ссылке, и мутация на месте не вызвала бы перерисовку.
    this.pending = [...this.pending]
    this.listeners.forEach((l) => l())
  }

  setTransport(send: OutboxSend | null) {
    this.send = send
  }

  // --- отправка ---
  enqueue(input: {
    target: OutboxTarget
    content: string
    replyTo?: number | null
    attachments?: Attachment[]
  }): string {
    const message: PendingMessage = {
      nonce: newNonce(),
      target: input.target,
      content: input.content,
      replyTo: input.replyTo ?? null,
      attachments: input.attachments ?? [],
      status: 'sending',
      attempt: 0,
      createdAt: Date.now(),
    }
    this.pending.push(message)
    this.attempt(message)
    return message.nonce
  }

  /** Повторить вручную — кнопка на сообщении со статусом «не доставлено». */
  retry(nonce: string) {
    const message = this.pending.find((m) => m.nonce === nonce)
    if (!message || message.status === 'sending') return
    // Счётчик обнуляем: это новое решение человека, а не продолжение
    // автоматической серии, которая уже исчерпала себя.
    message.attempt = 0
    message.status = 'sending'
    message.error = undefined
    this.removeDraft(message)
    this.attempt(message)
  }

  /** Убрать сообщение совсем — кнопка «удалить» на неотправленном. */
  discard(nonce: string) {
    const message = this.pending.find((m) => m.nonce === nonce)
    if (!message) return
    this.clearTimer(nonce)
    this.removeDraft(message)
    this.pending = this.pending.filter((m) => m.nonce !== nonce)
    this.emit()
  }

  private attempt(message: PendingMessage) {
    message.attempt += 1
    this.clearTimer(message.nonce)
    // Отправляем даже без транспорта? Нет — но и не проваливаем сразу:
    // транспорт ставится сразу после монтирования AppShell, а таймер ниже
    // всё равно приведёт к повторной попытке.
    this.send?.(message)
    this.timers.set(
      message.nonce,
      setTimeout(() => this.onTimeout(message.nonce), DELIVERY_CONFIG.ackTimeoutMs),
    )
    this.emit()
  }

  private onTimeout(nonce: string) {
    const message = this.pending.find((m) => m.nonce === nonce)
    if (!message || message.status !== 'sending') return
    if (message.attempt >= DELIVERY_CONFIG.maxAttempts) {
      this.fail(message, 'Сервер не подтвердил доставку.')
      return
    }
    // Экспоненциальная задержка перед повтором — тот же приём, что у
    // реконнекта gateway: мгновенный повтор в мёртвую сеть бессмысленен.
    const backoff = Math.min(
      DELIVERY_CONFIG.retryBaseMs * 2 ** (message.attempt - 1),
      DELIVERY_CONFIG.retryMaxMs,
    )
    this.timers.set(
      nonce,
      setTimeout(() => {
        const current = this.pending.find((m) => m.nonce === nonce)
        if (current && current.status === 'sending') this.attempt(current)
      }, backoff),
    )
  }

  private fail(message: PendingMessage, reason: string) {
    this.clearTimer(message.nonce)
    message.status = 'failed'
    message.error = reason
    this.saveDraft(message)
    this.emit()
  }

  // --- события от gateway ---
  /** Сообщение подтверждено сервером — убираем из очереди.
   *
   * Сама доставленная копия приезжает обычным message_create и попадает в
   * ленту как настоящее сообщение, поэтому держать её ещё и здесь незачем:
   * иначе она отрисовалась бы дважды. */
  ack(nonce: string) {
    const message = this.pending.find((m) => m.nonce === nonce)
    if (!message) return
    this.clearTimer(nonce)
    this.removeDraft(message)
    this.pending = this.pending.filter((m) => m.nonce !== nonce)
    this.emit()
  }

  /** Явный отказ сервера — повторять бессмысленно (прав не прибавится),
   * сразу в черновики. */
  nack(nonce: string, reason?: string) {
    const message = this.pending.find((m) => m.nonce === nonce)
    if (!message) return
    this.fail(message, reason || 'Сервер отклонил сообщение.')
  }

  /** Сокет переподключился — есть смысл немедленно повторить всё, что висит,
   * не дожидаясь своих таймеров. */
  flush() {
    for (const message of this.pending) {
      if (message.status === 'sending') this.attempt(message)
    }
  }

  private clearTimer(nonce: string) {
    const timer = this.timers.get(nonce)
    if (timer) clearTimeout(timer)
    this.timers.delete(nonce)
  }

  // --- черновики ---
  private saveDraft(message: PendingMessage) {
    const store = readDrafts()
    const key = targetKey(message.target)
    const list = (store[key] ?? []).filter((m) => m.nonce !== message.nonce)
    list.push(message)
    store[key] = list.slice(-DELIVERY_CONFIG.maxDraftsPerTarget)
    writeDrafts(store)
  }

  private removeDraft(message: PendingMessage) {
    const store = readDrafts()
    const key = targetKey(message.target)
    if (!store[key]) return
    store[key] = store[key].filter((m) => m.nonce !== message.nonce)
    if (store[key].length === 0) delete store[key]
    writeDrafts(store)
  }
}

export const outbox = new Outbox()

/** Неотправленные сообщения одной беседы/канала.
 *
 * Возвращает ГОТОВЫЕ к отрисовке объекты формы ChatMessageBase, чтобы
 * MessageList не пришлось учить второму типу сообщения: у неотправленного
 * отрицательный id (настоящих таких не бывает — ключ в списке остаётся
 * уникальным) и отдельно отданный статус доставки. */
export function usePendingMessages(target: OutboxTarget | null) {
  const all = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot)
  if (!target) return []
  return all.filter(
    (m) => m.target.kind === target.kind && m.target.id === target.id,
  )
}

/** Оборачивает неотправленное сообщение в форму обычного, чтобы отрисовать
 * его тем же кодом. author подставляется вызывающим — это всегда мы сами. */
export function pendingAsMessage(
  pending: PendingMessage,
  author: User,
): ChatMessageBase & { pendingNonce: string; deliveryStatus: DeliveryStatus } {
  return {
    // Отрицательный id: он нужен только как React-ключ и как признак «это
    // ещё не сообщение». Хеш от nonce, чтобы два неотправленных не совпали.
    id: -Math.abs(hashNonce(pending.nonce)),
    author,
    content: pending.content,
    reply_to: null,
    attachments: pending.attachments,
    reactions: [],
    created_at: new Date(pending.createdAt).toISOString(),
    edited_at: null,
    pendingNonce: pending.nonce,
    deliveryStatus: pending.status,
  }
}

function hashNonce(nonce: string): number {
  // Обычный djb2 — нужна лишь стабильная уникальность ключа в пределах
  // списка, криптостойкость тут не при чём.
  let hash = 5381
  for (let i = 0; i < nonce.length; i += 1) {
    hash = ((hash << 5) + hash + nonce.charCodeAt(i)) | 0
  }
  // 0 исключаем: id=-0 совпал бы с настоящим id=0.
  return Math.abs(hash) || 1
}
