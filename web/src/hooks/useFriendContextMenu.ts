import { MouseEvent as ReactMouseEvent, useCallback, useState } from 'react'
import { api, Conversation, User } from '../api'
import { nicknameStore } from '../nicknames'

export interface FriendMenuTarget {
  friend: User
  x: number
  y: number
}

/**
 * Контекстное меню строки друга (правый клик в списке «Друзья», см.
 * FriendContextMenu) — состояние и действия его пунктов.
 *
 * Живёт хуком на уровне AppShell по той же причине, что и меню диалога: три
 * пункта из четырёх уводят ЗА пределы сайдбара — открывают карточку профиля,
 * переключают на беседу, начинают звонок. Четвёртый (никнейм) открывает свою
 * модалку, которая тоже рендерится в общем слое оверлеев.
 *
 * «Написать сообщение» и «Начать звонок» опираются на одно и то же: диалога с
 * другом может ещё не существовать, поэтому оба сначала создают/находят его
 * (createConversation для kind=dm идемпотентен — сервер возвращает уже
 * существующую беседу).
 */
export function useFriendContextMenu({
  setConversations,
  setActiveConversationId,
  setServerId,
  onStartCall,
  onOpenProfile,
}: {
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>
  setActiveConversationId: (id: number | null) => void
  setServerId: (id: number | null) => void
  onStartCall: (conversationId: number) => void
  onOpenProfile: (friend: User, x: number, y: number) => void
}) {
  const [menuTarget, setMenuTarget] = useState<FriendMenuTarget | null>(null)
  const [nicknameTarget, setNicknameTarget] = useState<User | null>(null)

  const openFriendContextMenu = useCallback((friend: User, e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuTarget({ friend, x: e.clientX, y: e.clientY })
  }, [])

  const closeMenu = useCallback(() => setMenuTarget(null), [])

  /** Найти или создать личку с другом и переключиться на неё. Возвращает
   * беседу — звонку нужен её id. */
  const openDm = useCallback(
    async (friend: User): Promise<Conversation | null> => {
      try {
        const conv = await api.createConversation({ kind: 'dm', user_ids: [friend.id] })
        setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]))
        setServerId(null)
        setActiveConversationId(conv.id)
        return conv
      } catch (e) {
        // Тем же способом, что и остальные действия с беседами (см.
        // useConversationsData): диалог не открылся — сказать об этом надо
        // сразу, отдельного места под ошибку в сайдбаре нет.
        alert('Не удалось открыть диалог: ' + (e as Error).message)
        return null
      }
    },
    [setConversations, setServerId, setActiveConversationId],
  )

  const handleSendMessage = useCallback(
    (friend: User) => void openDm(friend),
    [openDm],
  )

  const handleStartCall = useCallback(
    async (friend: User) => {
      const conv = await openDm(friend)
      if (conv) onStartCall(conv.id)
    },
    [openDm, onStartCall],
  )

  /** Сохранение никнейма. Стор правим сразу после успеха — имя меняется во
   * всех списках разом (см. nicknames.ts), перечитывать ничего не нужно. */
  const handleSaveNickname = useCallback(
    async (friend: User, nickname: string) => {
      const saved = await api.setUserNickname(friend.id, nickname)
      nicknameStore.set(friend.id, saved.nickname)
    },
    [],
  )

  return {
    menuTarget,
    closeMenu,
    openFriendContextMenu,
    nicknameTarget,
    setNicknameTarget,
    handleSendMessage,
    handleStartCall,
    handleSaveNickname,
    handleOpenProfile: onOpenProfile,
  }
}
