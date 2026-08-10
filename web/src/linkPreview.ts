/** Превью ссылок на стороне клиента: находим ссылку в тексте и просим бэкенд
 * собрать карточку (см. backend chat/linkpreview.py — там же почему тянет
 * клиент, а не пайплайн сообщений).
 *
 * Кэш и дедупликация здесь обязательны, а не «на всякий случай»: одна и та же
 * ссылка встречается в ленте много раз, лента перерисовывается на каждое
 * новое сообщение, и без них каждый рендер порождал бы новый запрос.
 */
import { useEffect, useState } from 'react'
import { api, LinkPreview } from './api'

/** Та же грубая эвристика, что и в backend chat/linkpreview.py (URL_RE):
 * точный разбор URL из свободного текста невозможен, а цена ошибки — не
 * показанная карточка. */
const URL_RE = /https?:\/\/[^\s<>"']+/i

/** Первая ссылка сообщения — карточка показывается только для неё, иначе
 * сообщение из десятка ссылок превратится в простыню. */
export function firstUrl(text: string): string | null {
  const match = URL_RE.exec(text || '')
  if (!match) return null
  // Хвостовая пунктуация принадлежит предложению, а не ссылке.
  const url = match[0].replace(/[.,;:!?)\]}'"]+$/, '')
  return url || null
}

/** null — сходили и превью нет (битая ссылка, не html, нечего показывать).
 * undefined — ещё не ходили. Разные состояния: во втором можно попробовать. */
const cache = new Map<string, LinkPreview | null>()
// Запрос уже в пути — второй компонент с той же ссылкой должен дождаться его,
// а не послать свой.
const inFlight = new Map<string, Promise<LinkPreview | null>>()

function load(url: string): Promise<LinkPreview | null> {
  const cached = cache.get(url)
  if (cached !== undefined) return Promise.resolve(cached)
  const running = inFlight.get(url)
  if (running) return running

  const promise = api
    .linkPreview(url)
    .then((preview) => {
      cache.set(url, preview)
      return preview
    })
    .catch(() => {
      // 404 «превью недоступно» — штатный ответ, а не сбой: запоминаем, что
      // показывать нечего, и больше не спрашиваем.
      cache.set(url, null)
      return null
    })
    .finally(() => {
      inFlight.delete(url)
    })

  inFlight.set(url, promise)
  return promise
}

/** Превью для текста сообщения. null — ссылки нет либо карточки не будет. */
export function useLinkPreview(content: string): LinkPreview | null {
  const url = firstUrl(content)
  const [preview, setPreview] = useState<LinkPreview | null>(() =>
    url ? cache.get(url) ?? null : null,
  )

  useEffect(() => {
    if (!url) {
      setPreview(null)
      return
    }
    let alive = true
    void load(url).then((result) => {
      if (alive) setPreview(result)
    })
    return () => {
      alive = false
    }
  }, [url])

  return preview
}
