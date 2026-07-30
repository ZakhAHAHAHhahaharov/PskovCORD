/**
 * Черновики композера — то, что набрано, но ещё не отправлено.
 *
 * Не путать с черновиками в outbox.ts: там лежат сообщения, которые УЖЕ
 * пытались уйти и не долетели (со статусом «не доставлено», кнопками
 * «повторить»/«удалить»). Здесь — то, что человек напечатал и прикрепил, но
 * Enter ещё не нажал.
 *
 * Раньше это жило в обычной Map прямо в AppShell: переключение каналов текст
 * переживал, а перезагрузка страницы, закрытие вкладки или падение клиента —
 * нет, и набранное пропадало бесследно. Теперь то же самое лежит в
 * localStorage.
 *
 * Про вложения. Сами файлы здесь НЕ хранятся — только ссылки на уже
 * загруженные (api.uploadAttachment грузит файл сразу при выборе, ещё до
 * отправки сообщения, см. MessageInput). То есть в черновик уезжают
 * несколько сотен байт метаданных, а не мегабайты base64: и квоты
 * localStorage хватает, и картинка после перезагрузки берётся с сервера, где
 * она и так уже лежит. Файл, который на момент ухода из канала ещё не
 * догрузился, в черновик не попадает — прикреплять придётся заново.
 */
import { Attachment } from './api'

const KEY_PREFIX = 'pskovcord:composer_drafts:v1'

/** Черновики старше этого срока выбрасываются при первом же чтении: хранить
 * вечно то, что человек набрал и забыл полгода назад, незачем. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** Сколько каналов/диалогов одновременно помнят черновик. Вытесняются самые
 * давние по времени последней правки. */
const MAX_ENTRIES = 50

export interface ComposerDraft {
  text: string
  /** Уже загруженные на сервер вложения (см. докстринг модуля). */
  attachments: Attachment[]
}

interface StoredDraft extends ComposerDraft {
  updatedAt: number
}

type DraftStore = Record<string, StoredDraft>

/** Ключ хранилища свой у каждого аккаунта: на одном устройстве может быть
 * авторизовано несколько (см. accounts.ts), и черновик, набранный одним, не
 * должен всплыть в композере у другого. */
function storageKey(scope: number): string {
  return `${KEY_PREFIX}:${scope}`
}

function read(scope: number): DraftStore {
  try {
    const raw = localStorage.getItem(storageKey(scope))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as DraftStore
    if (!parsed || typeof parsed !== 'object') return {}
    const cutoff = Date.now() - MAX_AGE_MS
    const fresh: DraftStore = {}
    for (const [key, draft] of Object.entries(parsed)) {
      if (!draft || typeof draft.text !== 'string') continue
      if ((draft.updatedAt ?? 0) < cutoff) continue
      fresh[key] = {
        text: draft.text,
        attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
        updatedAt: draft.updatedAt ?? 0,
      }
    }
    return fresh
  } catch {
    // Битый JSON или недоступный localStorage (приватный режим) — не повод
    // ронять чат: черновики просто не переживут перезагрузку.
    return {}
  }
}

function write(scope: number, store: DraftStore): void {
  try {
    const entries = Object.entries(store)
    // Вытеснение самых давних — localStorage не резиновый, а квота на домен
    // общая с остальным (см. outbox.ts, настройки, кэш профиля).
    const kept =
      entries.length <= MAX_ENTRIES
        ? entries
        : entries
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
            .slice(0, MAX_ENTRIES)
    localStorage.setItem(storageKey(scope), JSON.stringify(Object.fromEntries(kept)))
  } catch {
    /* переполнен или недоступен — молча живём без черновиков */
  }
}

export function loadComposerDraft(scope: number, key: string): ComposerDraft | undefined {
  const draft = read(scope)[key]
  if (!draft) return undefined
  return { text: draft.text, attachments: draft.attachments }
}

/** Пустой черновик (ни текста, ни вложений) стирает запись, а не сохраняет
 * пустышку — иначе отправленное сообщение оставляло бы после себя мусор. */
export function saveComposerDraft(scope: number, key: string, draft: ComposerDraft): void {
  const store = read(scope)
  if (!draft.text && draft.attachments.length === 0) {
    if (!(key in store)) return
    delete store[key]
  } else {
    store[key] = { ...draft, updatedAt: Date.now() }
  }
  write(scope, store)
}
