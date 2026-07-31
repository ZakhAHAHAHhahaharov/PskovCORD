/**
 * Гифки анимированных аватаров: загрузка по требованию + кэш на всё
 * приложение.
 *
 * Почему так. Аватар едет в КАЖДОМ сообщении и КАЖДОЙ строке ростера, поэтому
 * в профиле лежит только статичный кадр (User.avatar_image) и флаг
 * User.avatar_animated — сама гифка догружается отдельной ручкой ровно тогда,
 * когда её надо показать (см. backend chat.views.UserAvatarAnimation).
 *
 * Показывается анимация в трёх случаях, и все три — короткие вспышки, часто
 * повторяющиеся для одних и тех же людей:
 *   1. человек говорит в голосовом канале;
 *   2. навели курсор на его аватар/ник в списке сообщений;
 *   3. открыта карточка профиля (там играет всегда).
 * Без кэша наведение мышью на собеседника означало бы новый запрос на каждое
 * движение — поэтому загруженная гифка остаётся в памяти вкладки до конца
 * сессии, а параллельные запросы на одного и того же человека схлопываются в
 * один промис.
 */
import { useEffect, useState } from 'react'
import { api } from './api'

/** userId → data-URL гифки ('' = анимации нет, тоже кэшируем: отрицательный
 * ответ так же ценен, чтобы не спрашивать снова). */
const cache = new Map<number, string>()
const inFlight = new Map<number, Promise<string>>()
/** userId → тот же кадр в виде Blob (null = анимации нет). Нужен, чтобы на
 * КАЖДОЕ включение анимации выдавать свежий object-URL — см. useAvatarAnimation. */
const blobCache = new Map<number, Blob | null>()

export function loadAvatarAnimation(userId: number): Promise<string> {
  const cached = cache.get(userId)
  if (cached !== undefined) return Promise.resolve(cached)
  const running = inFlight.get(userId)
  if (running) return running
  const promise = api
    .avatarAnimation(userId)
    .then((res) => {
      cache.set(userId, res.avatar_anim)
      return res.avatar_anim
    })
    .catch(() => '')
    .finally(() => inFlight.delete(userId))
  inFlight.set(userId, promise)
  return promise
}

/** Забыть гифку пользователя — после смены аватара (profile_update по WS или
 * собственный PATCH). Без этого у всех, кто уже успел её посмотреть,
 * проигрывалась бы прежняя до перезагрузки вкладки. */
export function invalidateAvatarAnimation(userId: number): void {
  cache.delete(userId)
  inFlight.delete(userId)
  blobCache.delete(userId)
}

/** data-URL → Blob разбором base64 на месте: fetch() умеет то же самое, но
 * асинхронно, а нам нужен синхронный путь для уже загруженной гифки (иначе
 * повторное наведение мышью мигало бы статичным кадром). */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma === -1) return null
  const header = dataUrl.slice(5, comma)
  const body = dataUrl.slice(comma + 1)
  const type = header.split(';')[0] || 'image/gif'
  try {
    if (!header.includes('base64')) {
      return new Blob([decodeURIComponent(body)], { type })
    }
    const binary = atob(body)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type })
  } catch {
    return null
  }
}

/** Blob гифки, если она уже на руках: undefined — ещё не загружали. */
function cachedBlob(userId: number): Blob | null | undefined {
  const known = blobCache.get(userId)
  if (known !== undefined) return known
  const dataUrl = cache.get(userId)
  if (dataUrl === undefined) return undefined
  const blob = dataUrl ? dataUrlToBlob(dataUrl) : null
  blobCache.set(userId, blob)
  return blob
}

/**
 * Гифка для пользователя, пока `active` — иначе null.
 *
 * Загрузка стартует только при active: пока анимацию показывать не просят,
 * трафика нет вовсе. Уже загруженная отдаётся из кэша тем же эффектом, без
 * сети — поэтому повторное наведение мышью не мигает статикой.
 *
 * Отдаётся не data-URL, а СВЕЖИЙ object-URL на каждое включение. Так гифка
 * каждый раз играет с первого кадра: у одинакового URL браузер держит одну
 * общую декодированную картинку с общим таймлайном анимации, и второй
 * показ (человек замолчал и заговорил снова) подхватывал её с середины —
 * с того кадра, до которого она «доиграла» в прошлый раз. Уникальный URL —
 * отдельная картинка, то есть гарантированный старт с начала.
 */
export function useAvatarAnimation(
  userId: number | undefined,
  animated: boolean,
  active: boolean,
): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (userId == null || !animated || !active) {
      setSrc(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    const show = (blob: Blob | null) => {
      // Курсор уже увели / человек замолчал, пока гифка ехала — показывать
      // её теперь незачем.
      if (cancelled) return
      if (!blob) {
        setSrc(null)
        return
      }
      objectUrl = URL.createObjectURL(blob)
      setSrc(objectUrl)
    }
    const known = cachedBlob(userId)
    if (known !== undefined) show(known)
    else void loadAvatarAnimation(userId).then(() => show(cachedBlob(userId) ?? null))
    return () => {
      cancelled = true
      // Ссылка на object-URL держит Blob в памяти вкладки, пока её не
      // отпустишь: без revoke каждое «заговорил» подтекало бы гифкой.
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [userId, animated, active])

  return src
}
