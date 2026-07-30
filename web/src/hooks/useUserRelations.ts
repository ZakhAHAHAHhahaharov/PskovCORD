import { useEffect, useState } from 'react'
import { api } from '../api'

/**
 * Кого я игнорирую и кого заблокировал (см. backend chat.models.UserRelationState).
 *
 * Грузится один раз при входе. Нужны оба множества именно на клиенте, потому
 * что REST-ленты сервер фильтрует сам, а живые сообщения приезжают по
 * WebSocket мимо любой серверной фильтрации:
 *   blocked — сообщения таких авторов не показываем вовсе;
 *   ignored — сообщения показываем, но без уведомления и звука.
 */
export function useUserRelations() {
  const [blockedUserIds, setBlockedUserIds] = useState<Set<number>>(new Set())
  const [ignoredUserIds, setIgnoredUserIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await api.myRelations()
        if (cancelled) return
        setBlockedUserIds(new Set(list.filter((r) => r.blocked).map((r) => r.user_id)))
        setIgnoredUserIds(new Set(list.filter((r) => r.ignored).map((r) => r.user_id)))
      } catch {
        // Не смогли получить — работаем как будто никто не заблокирован:
        // это ровно прежнее поведение приложения, ничего не ломается.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { blockedUserIds, setBlockedUserIds, ignoredUserIds, setIgnoredUserIds }
}
