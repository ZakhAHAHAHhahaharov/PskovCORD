import { MouseEvent as ReactMouseEvent, useCallback, useState } from 'react'
import { api, Conversation, FriendsState, UserRelation } from '../api'

export interface ConversationMenuTarget {
  conversation: Conversation
  x: number
  y: number
}

/**
 * Контекстное меню диалога/группы (правый клик в списке «Диалоги», см.
 * ConversationContextMenu) — состояние и все действия его пунктов.
 *
 * Живёт хуком на уровне AppShell, а не внутри HomeSidebar, по той же причине,
 * что и мини-профиль: почти каждый пункт трогает состояние ЗА пределами
 * сайдбара — ленту непрочитанных, список бесед, звонок, карточку профиля.
 */
export function useConversationContextMenu({
  conversations,
  setConversations,
  setUnreadConversationIds,
  setActiveConversationId,
  activeConversationId,
  onStartCall,
  onOpenProfile,
  setBlockedUserIds,
  setIgnoredUserIds,
  setFriends,
  navigateToContent,
}: {
  conversations: Conversation[]
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>
  setUnreadConversationIds: React.Dispatch<React.SetStateAction<Set<number>>>
  setActiveConversationId: (id: number | null) => void
  activeConversationId: number | null
  onStartCall: (conversationId: number) => void
  /** Открыть карточку профиля собеседника (она же — место для заметки). */
  onOpenProfile: (conversation: Conversation, x: number, y: number) => void
  setBlockedUserIds: React.Dispatch<React.SetStateAction<Set<number>>>
  setIgnoredUserIds: React.Dispatch<React.SetStateAction<Set<number>>>
  setFriends: React.Dispatch<React.SetStateAction<FriendsState>>
  /** Переход в content-экран на мобилке (см. useMobileNav) — как при клике
   * по строке беседы, так и при «Написать сообщение» из её меню. */
  navigateToContent: () => void
}) {
  const [menuTarget, setMenuTarget] = useState<ConversationMenuTarget | null>(null)
  const [error, setError] = useState('')

  const openConversationContextMenu = useCallback(
    (conversation: Conversation, e: ReactMouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setMenuTarget({ conversation, x: e.clientX, y: e.clientY })
    },
    [],
  )

  const closeMenu = useCallback(() => setMenuTarget(null), [])

  /** «Написать сообщение» — беседа из этого меню уже существует, поэтому
   * просто переключаемся на неё, как и при клике по самой строке. */
  const handleSendMessage = useCallback(
    (conversation: Conversation) => {
      setActiveConversationId(conversation.id)
      navigateToContent()
    },
    [setActiveConversationId, navigateToContent],
  )

  /** «Пометить как прочитанное» — непрочитанность живёт только на клиенте
   * (сервер её не хранит, см. useConversationsData), поэтому и снимается
   * здесь же, локально. */
  const handleMarkRead = useCallback(
    (conversationId: number) => {
      setUnreadConversationIds((prev) => {
        if (!prev.has(conversationId)) return prev
        const next = new Set(prev)
        next.delete(conversationId)
        return next
      })
    },
    [setUnreadConversationIds],
  )

  const handleTogglePin = useCallback(
    async (conversation: Conversation) => {
      const pinned = !conversation.pinned
      // Оптимистично: закрепление — мгновенная перестановка в списке, ждать
      // сети ради неё незачем.
      setConversations((prev) =>
        prev.map((c) => (c.id === conversation.id ? { ...c, pinned } : c)),
      )
      try {
        await api.updateConversationSettings(conversation.id, { pinned })
      } catch (err) {
        setConversations((prev) =>
          prev.map((c) => (c.id === conversation.id ? { ...c, pinned: !pinned } : c)),
        )
        setError((err as Error).message)
      }
    },
    [setConversations],
  )

  /** «Закрыть ЛС» — убирает беседу из списка, не трогая ни историю, ни
   * участие: вернётся сама, когда собеседник напишет (см. backend
   * ConversationParticipant.closed). */
  const handleCloseConversation = useCallback(
    async (conversation: Conversation) => {
      const snapshot = conversations
      setConversations((prev) => prev.filter((c) => c.id !== conversation.id))
      if (activeConversationId === conversation.id) setActiveConversationId(null)
      try {
        await api.updateConversationSettings(conversation.id, { closed: true })
      } catch (err) {
        setConversations(snapshot)
        setError((err as Error).message)
      }
    },
    [conversations, setConversations, activeConversationId, setActiveConversationId],
  )

  const handleInviteToServer = useCallback(
    async (conversation: Conversation, serverId: number) => {
      const peer = conversation.participants[0]
      if (!peer) return
      try {
        // Та же ручка, что и у «Пригласить» из списка участников: сервер сам
        // кладёт карточку приглашения в переписку с ним (см. backend
        // _send_invite_message), отдельно слать сообщение не нужно.
        await api.inviteToServer(serverId, peer.id)
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [],
  )

  const handleRemoveFriend = useCallback(
    async (conversation: Conversation) => {
      const peer = conversation.participants[0]
      if (!peer) return
      try {
        await api.removeFriend(peer.id)
        setFriends(await api.friends())
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [setFriends],
  )

  /** Игнор/блокировка уже отправлены самим меню — здесь только приводим в
   * соответствие локальные множества, по которым фильтруются лента и
   * уведомления. */
  const handleRelationChange = useCallback(
    (conversation: Conversation, relation: UserRelation) => {
      const peer = conversation.participants[0]
      if (!peer) return
      const apply = (
        setter: React.Dispatch<React.SetStateAction<Set<number>>>,
        on: boolean,
      ) =>
        setter((prev) => {
          if (prev.has(peer.id) === on) return prev
          const next = new Set(prev)
          if (on) next.add(peer.id)
          else next.delete(peer.id)
          return next
        })
      apply(setIgnoredUserIds, relation.ignored)
      apply(setBlockedUserIds, relation.blocked)
    },
    [setIgnoredUserIds, setBlockedUserIds],
  )

  return {
    menuTarget, closeMenu, openConversationContextMenu,
    conversationMenuError: error, clearConversationMenuError: () => setError(''),
    handleMarkRead, handleTogglePin, handleCloseConversation, handleSendMessage,
    handleInviteToServer, handleRemoveFriend, handleRelationChange,
    handleStartCall: onStartCall, handleOpenPeerProfile: onOpenProfile,
  }
}
