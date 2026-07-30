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

export function getCachedAvatarAnimation(userId: number): string | undefined {
  return cache.get(userId)
}

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
}

/**
 * Гифка для пользователя, пока `active` — иначе null.
 *
 * Загрузка стартует только при active: пока анимацию показывать не просят,
 * трафика нет вовсе. Уже загруженная отдаётся синхронно, первым же рендером —
 * поэтому повторное наведение мышью не мигает статикой.
 */
export function useAvatarAnimation(
  userId: number | undefined,
  animated: boolean,
  active: boolean,
): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    userId != null && animated && active ? getCachedAvatarAnimation(userId) ?? null : null,
  )

  useEffect(() => {
    if (userId == null || !animated || !active) {
      setSrc(null)
      return
    }
    const cached = getCachedAvatarAnimation(userId)
    if (cached !== undefined) {
      setSrc(cached || null)
      return
    }
    let cancelled = false
    void loadAvatarAnimation(userId).then((anim) => {
      // Курсор уже увели / человек замолчал, пока гифка ехала — показывать
      // её теперь незачем.
      if (!cancelled) setSrc(anim || null)
    })
    return () => {
      cancelled = true
    }
  }, [userId, animated, active])

  return src
}
