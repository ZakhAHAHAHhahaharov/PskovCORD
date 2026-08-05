import { MouseEvent as ReactMouseEvent, useCallback, useState } from 'react'
import { api, Conversation, FriendsState, UserRelation } from '../api'
import { useContextMenuState } from '../contextMenuStack'
import { nicknameStore } from '../nicknames'
import { ProfilePopupUser } from '../components/MiniProfilePopup'

export interface FriendMenuTarget {
  friend: ProfilePopupUser
  /** Уже в друзьях — от этого зависит, показывать «Удалить из друзей» или
   * «Добавить в друзья» (см. FriendContextMenu). Меню открывается не только
   * из списка друзей (там всегда true), но и, например, из списка
   * отреагировавших на сообщение (см. MessageReactionsModal), где человек
   * может оказаться кем угодно. */
  isFriend: boolean
  x: number
  y: number
}

/**
 * Контекстное меню строки друга (правый клик в списке «Друзья», см.
 * FriendContextMenu) — состояние и действия его пунктов. Тем же меню
 * пользуется и правый клик по любому другому человеку вне списка друзей
 * (см. FriendMenuTarget.isFriend) — friend здесь не обязательно друг, просто
 * унаследованное от первого применения имя.
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
 *
 * Тип friend — ProfilePopupUser, а не User: цель меню приезжает из разных
 * источников (FriendsState.friends — полноценные User, но и MentionCandidate
 * из списка отреагировавших — набор полей поуже), а хуку/меню реально нужен
 * только id и то, что достаточно для мини-профиля (см. handleOpenProfile). */
export function useFriendContextMenu({
  setConversations,
  setActiveConversationId,
  setServerId,
  setFriends,
  setBlockedUserIds,
  setIgnoredUserIds,
  onStartCall,
  onOpenProfile,
}: {
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>
  setActiveConversationId: (id: number | null) => void
  setServerId: (id: number | null) => void
  setFriends: React.Dispatch<React.SetStateAction<FriendsState>>
  setBlockedUserIds: React.Dispatch<React.SetStateAction<Set<number>>>
  setIgnoredUserIds: React.Dispatch<React.SetStateAction<Set<number>>>
  onStartCall: (conversationId: number) => void
  onOpenProfile: (friend: ProfilePopupUser, x: number, y: number) => void
}) {
  const [menuTarget, setMenuTarget] = useContextMenuState<FriendMenuTarget>()
  const [nicknameTarget, setNicknameTarget] = useState<ProfilePopupUser | null>(null)

  const openFriendContextMenu = useCallback(
    (friend: ProfilePopupUser, isFriend: boolean, e: ReactMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setMenuTarget({ friend, isFriend, x: e.clientX, y: e.clientY })
    },
    [],
  )

  const closeMenu = useCallback(() => setMenuTarget(null), [])

  /** Найти или создать личку с другом и переключиться на неё. Возвращает
   * беседу — звонку нужен её id. */
  const openDm = useCallback(
    async (friend: ProfilePopupUser): Promise<Conversation | null> => {
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
    (friend: ProfilePopupUser) => void openDm(friend),
    [openDm],
  )

  const handleStartCall = useCallback(
    async (friend: ProfilePopupUser) => {
      const conv = await openDm(friend)
      if (conv) onStartCall(conv.id)
    },
    [openDm, onStartCall],
  )

  /** Сохранение никнейма. Стор правим сразу после успеха — имя меняется во
   * всех списках разом (см. nicknames.ts), перечитывать ничего не нужно. */
  const handleSaveNickname = useCallback(
    async (friend: ProfilePopupUser, nickname: string) => {
      const saved = await api.setUserNickname(friend.id, nickname)
      nicknameStore.set(friend.id, saved.nickname)
    },
    [],
  )

  /** «Удалить из друзей» — та же ручка, что и у одноимённого пункта в меню
   * диалога (см. ConversationContextMenu) и в мини-профиле. */
  const handleRemoveFriend = useCallback(
    async (friend: ProfilePopupUser) => {
      try {
        await api.removeFriend(friend.id)
        setFriends(await api.friends())
      } catch (e) {
        alert((e as Error).message)
      }
    },
    [setFriends],
  )

  const handleInviteToServer = useCallback(async (friend: ProfilePopupUser, serverId: number) => {
    try {
      await api.inviteToServer(serverId, friend.id)
    } catch (e) {
      alert((e as Error).message)
    }
  }, [])

  /** Игнор/блокировка уже отправлены самим меню (см. FriendContextMenu) —
   * здесь только приводим в соответствие локальные множества, по которым
   * фильтруются лента и уведомления (тот же приём, что и в меню диалога). */
  const handleRelationChange = useCallback(
    (friend: ProfilePopupUser, relation: UserRelation) => {
      const apply = (
        setter: React.Dispatch<React.SetStateAction<Set<number>>>,
        on: boolean,
      ) =>
        setter((prev) => {
          if (prev.has(friend.id) === on) return prev
          const next = new Set(prev)
          if (on) next.add(friend.id)
          else next.delete(friend.id)
          return next
        })
      apply(setIgnoredUserIds, relation.ignored)
      apply(setBlockedUserIds, relation.blocked)
    },
    [setIgnoredUserIds, setBlockedUserIds],
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
    handleRemoveFriend,
    handleInviteToServer,
    handleRelationChange,
    handleOpenProfile: onOpenProfile,
  }
}
