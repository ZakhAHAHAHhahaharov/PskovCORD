import { MutableRefObject, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { api, Channel, ChatMessageBase, Message } from '../api'
import { OutgoingMessage } from '../components/MessageInput'
import { useGateway } from '../gateway'
import { outbox } from '../outbox'

/** Сообщения текстового канала сервера: история, черновик ответа/редактирования,
 * отправка/удаление/реакции. `pendingEditsRef` общий с useConversationsData
 * (ключи "channel-N"/"dm-N" в одной Map) — передаётся снаружи, а не создаётся
 * здесь, чтобы незавершённое редактирование переживало переключение между
 * каналом сервера и диалогом/группой. */
export function useChannelMessages(
  currentChannel: Channel | null,
  channelId: number | null,
  gateway: ReturnType<typeof useGateway>,
  pendingEditsRef: MutableRefObject<Map<string, ChatMessageBase>>,
) {
  const [messages, setMessages] = useState<Message[]>([])
  // Читаются в обработчике "ready" (добор пропущенного) — через ref, чтобы не
  // тащить их в зависимости большого gateway-эффекта.
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const [replyTarget, setReplyTarget] = useState<ChatMessageBase | null>(null)
  const [editTarget, setEditTarget] = useState<ChatMessageBase | null>(null)
  // Всегда актуальное значение editTarget — читается в cleanup-функции
  // эффекта переключения канала (см. ниже), где сам editTarget из замыкания
  // был бы устаревшим (значением на момент запуска ТОГО эффекта, а не на
  // момент выхода из канала).
  const editTargetRef = useRef<ChatMessageBase | null>(null)
  const setEditTargetTracked = useCallback((m: ChatMessageBase | null) => {
    editTargetRef.current = m
    setEditTarget(m)
  }, [])

  // История сообщений при смене текстового канала. useLayoutEffect — по той
  // же причине, что и у аналогичного эффекта для ЛС: без него editTarget
  // уходящего канала на миг мелькнул бы в новом.
  useLayoutEffect(() => {
    setReplyTarget(null)
    const key = currentChannel && currentChannel.kind === 'text' ? `channel-${currentChannel.id}` : null
    const restored = key ? pendingEditsRef.current.get(key) ?? null : null
    setEditTargetTracked(restored)
    if (!currentChannel || currentChannel.kind !== 'text') {
      setMessages([])
    } else {
      ;(async () => {
        try {
          setMessages(await api.messages(currentChannel.id))
        } catch {
          setMessages([])
        }
      })()
    }
    // Уход из канала (смена channelId или размонтирование) — запоминаем, на
    // чём остановилось редактирование, чтобы отдать его обратно при
    // возврате именно в этот канал.
    return () => {
      if (!key) return
      if (editTargetRef.current) pendingEditsRef.current.set(key, editTargetRef.current)
      else pendingEditsRef.current.delete(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, setEditTargetTracked])

  // Отправка идёт не напрямую в сокет, а через очередь: та рисует сообщение
  // сразу, ждёт подтверждения, при молчании повторяет, а окончательно
  // провалившееся кладёт в черновики (см. outbox.ts).
  const handleSend = (message: OutgoingMessage) => {
    if (channelId == null) return
    outbox.enqueue({
      target: { kind: 'channel', id: channelId },
      content: message.content,
      replyTo: replyTarget?.id ?? null,
      attachments: message.attachments,
    })
    setReplyTarget(null)
  }

  // Реакции переключаются по факту «стоит ли она уже у меня» — его считает
  // MessageList из user_ids, отдельно этот флаг нигде не хранится.
  const handleToggleReaction = useCallback(
    (messageId: number, emoji: string, mine: boolean) => {
      if (mine) gateway.removeReaction(messageId, emoji)
      else gateway.addReaction(messageId, emoji)
    },
    [gateway],
  )

  const handleDeleteMessage = (messageId: number) => {
    gateway.deleteMessage(messageId)
  }

  const handleReplyRequest = (m: ChatMessageBase) => {
    setEditTargetTracked(null)
    setReplyTarget(m)
  }

  const handleEditRequest = (m: ChatMessageBase) => {
    setReplyTarget(null)
    setEditTargetTracked(m)
  }

  /** Закрепить/открепить. Ответ придёт обычным message_update (см.
   * chat.consumers._handle_pin_message) и обновит сообщение в ленте у всех,
   * поэтому локально ничего не трогаем. */
  const handleTogglePin = useCallback(
    (messageId: number, pinned: boolean) => {
      gateway.pinMessage(messageId, pinned)
    },
    [gateway],
  )

  const handleSaveEdit = (messageId: number, content: string) => {
    gateway.editMessage(messageId, content)
    setEditTargetTracked(null)
  }

  return {
    messages, setMessages, messagesRef,
    replyTarget, setReplyTarget,
    editTarget, setEditTargetTracked,
    handleSend, handleToggleReaction, handleDeleteMessage,
    handleReplyRequest, handleEditRequest, handleSaveEdit, handleTogglePin,
  }
}
