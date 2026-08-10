import { MutableRefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  api, ChatMessageBase, Conversation, ConversationMessage, FriendsState, KnownPerson,
} from '../api'
import { useGateway } from '../gateway'
import { OutgoingMessage } from '../components/MessageInput'
import { nicknameStore } from '../nicknames'
import { outbox } from '../outbox'
import { presenceStore } from '../presence'

/** Домашний экран: диалоги/группы, друзья, звонки в них — весь DM-домен
 * AppShell. Ростер звонка в диалоге/группе (dmCallParticipants) и сам звонок
 * (voice) сюда не входят — это часть voice-домена (useVoiceCall), который
 * читает `conversations`/`activeConversationId` отсюда как вход. */
export function useConversationsData(
  gateway: ReturnType<typeof useGateway>,
  setServerId: (id: number | null) => void,
  showServerInviteId: number | null,
  closeProfilePopup: () => void,
  pendingEditsRef: MutableRefObject<Map<string, ChatMessageBase>>,
) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  // Как и voiceRef: читаем в обработчиках через ref, чтобы conversations не
  // висел в зависимостях большого gateway-эффекта. Раньше висел — и любое
  // входящее ЛС меняло список, эффект пересоздавался и заново
  // переподписывал все ~24 обработчика; сообщение, пришедшее в окне между
  // отпиской и подпиской, мог потерять любой из них.
  const conversationsRef = useRef<Conversation[]>([])
  conversationsRef.current = conversations
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)
  const [dmMessages, setDmMessages] = useState<ConversationMessage[]>([])
  const dmMessagesRef = useRef<ConversationMessage[]>([])
  dmMessagesRef.current = dmMessages
  const [dmReplyTarget, setDmReplyTarget] = useState<ChatMessageBase | null>(null)
  const [dmEditTarget, setDmEditTarget] = useState<ChatMessageBase | null>(null)
  // Всегда актуальное значение dmEditTarget — читается в cleanup-функции
  // эффекта переключения диалога (см. ниже), где сам dmEditTarget из
  // замыкания был бы устаревшим (значением на момент запуска ТОГО эффекта,
  // а не на момент выхода из диалога).
  const dmEditTargetRef = useRef<ChatMessageBase | null>(null)
  const setDmEditTargetTracked = useCallback((m: ChatMessageBase | null) => {
    dmEditTargetRef.current = m
    setDmEditTarget(m)
  }, [])
  // Диалоги с непрочитанными сообщениями — клиентское состояние (бэкенд не
  // хранит read-статус), сбрасывается при перезагрузке. Наполняется в
  // gateway.on('dm_message_create') (см. useGatewayEvents), чистится при
  // открытии диалога (см. handleSelectConversation) — используется для
  // общего счётчика уведомлений на домашней пилюле рельсы (см.
  // ServerRail.notificationCount).
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<number>>(new Set())
  const [friends, setFriends] = useState<FriendsState>({ friends: [], incoming: [], outgoing: [] })
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [knownPeople, setKnownPeople] = useState<KnownPerson[]>([])

  // Диалоги/группы и друзья — не завязаны на выбранный сервер, нужны сразу
  // (бейджи, домашний экран в любой момент). Приглашения на сервера теперь
  // приходят карточкой прямо в историю диалога (см. ConversationMessage.
  // server_invite) — отдельно грузить их не нужно.
  useEffect(() => {
    ;(async () => {
      try {
        setConversations(await api.conversations())
      } catch {
        setConversations([])
      }
      try {
        setFriends(await api.friends())
      } catch {
        setFriends({ friends: [], incoming: [], outgoing: [] })
      }
      // Онлайн-статус друзей/собеседников и мои никнеймы для них — два
      // снимка в общие сторы (см. presence.ts и nicknames.ts). Дальше оба
      // живут сами: presence капает по WS, никнеймы меняю только я сам.
      // Ошибку глотаем молча — без снимка точки статуса просто будут серыми,
      // а имена — обычными, приложение работает как раньше.
      try {
        presenceStore.merge(await api.presence())
      } catch {
        // см. выше
      }
      try {
        nicknameStore.merge(await api.myNicknames())
      } catch {
        // см. выше
      }
    })()
  }, [])

  // История сообщений выбранного диалога/группы. useLayoutEffect, а не
  // useEffect: восстановленный editTarget должен попасть в проп ДО того, как
  // браузер отрисует кадр — иначе на миг мелькнёт editTarget уходящего
  // диалога (стейт ещё не успел синхронизироваться с новым activeConversationId).
  useLayoutEffect(() => {
    setDmReplyTarget(null)
    const key = activeConversationId != null ? `dm-${activeConversationId}` : null
    const restored = key ? pendingEditsRef.current.get(key) ?? null : null
    setDmEditTargetTracked(restored)
    if (activeConversationId == null) {
      setDmMessages([])
    } else {
      ;(async () => {
        try {
          setDmMessages(await api.conversationMessages(activeConversationId))
        } catch {
          setDmMessages([])
        }
      })()
    }
    // Уход из диалога (смена activeConversationId или размонтирование) —
    // запоминаем, на чём остановилось редактирование, чтобы отдать его
    // обратно при возврате именно в этот диалог.
    return () => {
      if (!key) return
      if (dmEditTargetRef.current) pendingEditsRef.current.set(key, dmEditTargetRef.current)
      else pendingEditsRef.current.delete(key)
    }
  }, [activeConversationId, setDmEditTargetTracked, pendingEditsRef])

  // Список людей для пикера «новый диалог/группа» И «Пригласить на сервер» —
  // обновляем при каждом открытии любой из двух модалок (мог появиться новый
  // общий сервер/друг с прошлого раза).
  useEffect(() => {
    if (!showNewConversation && showServerInviteId == null) return
    ;(async () => {
      try {
        setKnownPeople(await api.knownPeople())
      } catch {
        setKnownPeople([])
      }
    })()
  }, [showNewConversation, showServerInviteId])

  const handleSelectConversation = useCallback((c: Conversation) => {
    setActiveConversationId(c.id)
    setUnreadConversationIds((prev) => {
      if (!prev.has(c.id)) return prev
      const next = new Set(prev)
      next.delete(c.id)
      return next
    })
  }, [])

  const handleCreateConversation = async (data: {
    kind: 'dm' | 'group'
    userIds: number[]
    name: string
  }) => {
    try {
      const conv = await api.createConversation({
        kind: data.kind, user_ids: data.userIds, name: data.name,
      })
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]))
      setActiveConversationId(conv.id)
      setShowNewConversation(false)
    } catch (e) {
      alert('Не удалось создать диалог: ' + (e as Error).message)
    }
  }

  const handleSendDm = (message: OutgoingMessage) => {
    if (activeConversationId == null) return
    outbox.enqueue({
      target: { kind: 'conversation', id: activeConversationId },
      content: message.content,
      replyTo: dmReplyTarget?.id ?? null,
      attachments: message.attachments,
      poll: message.poll,
    })
    setDmReplyTarget(null)
  }

  const handleDeleteDmMessage = (messageId: number) => {
    gateway.dmDeleteMessage(messageId)
  }

  const handleDmReplyRequest = (m: ChatMessageBase) => {
    setDmEditTargetTracked(null)
    setDmReplyTarget(m)
  }

  const handleDmEditRequest = (m: ChatMessageBase) => {
    setDmReplyTarget(null)
    setDmEditTargetTracked(m)
  }

  const handleSaveDmEdit = (messageId: number, content: string) => {
    gateway.dmEditMessage(messageId, content)
    setDmEditTargetTracked(null)
  }

  const handleSendFriendRequest = async (username: string) => {
    try {
      await api.sendFriendRequest({ username })
      setFriends(await api.friends())
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleAcceptFriendRequest = async (requestId: number) => {
    try {
      await api.acceptFriendRequest(requestId)
      setFriends(await api.friends())
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleDeclineFriendRequest = async (requestId: number) => {
    try {
      await api.declineFriendRequest(requestId)
      setFriends((prev) => ({
        ...prev,
        incoming: prev.incoming.filter((r) => r.id !== requestId),
        outgoing: prev.outgoing.filter((r) => r.id !== requestId),
      }))
    } catch (e) {
      alert((e as Error).message)
    }
  }

  // "Добавить в друзья"/"Написать сообщение" из мини-профиля (клик по чужому
  // аватару/нику где угодно — см. MiniProfilePopup). Возвращает успех, чтобы
  // сам попап показал отклик на кнопке (галочка/«Отправлено») — раньше клик
  // никак не подтверждался визуально.
  const handleMiniProfileAddFriend = async (userId: number): Promise<boolean> => {
    try {
      await api.sendFriendRequest({ userId })
      setFriends(await api.friends())
      return true
    } catch (e) {
      alert((e as Error).message)
      return false
    }
  }

  /** «Удалить из друзей» — и из карточки профиля, и из контекстного меню
   * диалога (см. ConversationContextMenu): ручка одна, точек входа две. */
  const handleRemoveFriend = async (userId: number): Promise<boolean> => {
    try {
      await api.removeFriend(userId)
      setFriends(await api.friends())
      return true
    } catch (e) {
      alert((e as Error).message)
      return false
    }
  }

  const handleMiniProfileSendMessage = async (userId: number, content: string) => {
    try {
      const conv = await api.createConversation({ kind: 'dm', user_ids: [userId] })
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]))
      setServerId(null)
      setActiveConversationId(conv.id)
      // Через ту же очередь, что и обычная отправка: сообщение из мини-профиля
      // ничем не отличается и должно так же ретраиться и попадать в черновики.
      outbox.enqueue({
        target: { kind: 'conversation', id: conv.id },
        content,
      })
      closeProfilePopup()
    } catch (e) {
      alert('Не удалось отправить сообщение: ' + (e as Error).message)
    }
  }

  return {
    conversations, setConversations, conversationsRef,
    activeConversationId, setActiveConversationId,
    dmMessages, setDmMessages, dmMessagesRef,
    dmReplyTarget, setDmReplyTarget,
    dmEditTarget, setDmEditTargetTracked,
    unreadConversationIds, setUnreadConversationIds,
    friends, setFriends,
    showNewConversation, setShowNewConversation,
    knownPeople,
    handleSelectConversation, handleCreateConversation,
    handleSendDm, handleDeleteDmMessage,
    handleDmReplyRequest, handleDmEditRequest, handleSaveDmEdit,
    handleSendFriendRequest, handleAcceptFriendRequest, handleDeclineFriendRequest,
    handleMiniProfileAddFriend, handleMiniProfileSendMessage, handleRemoveFriend,
  }
}
