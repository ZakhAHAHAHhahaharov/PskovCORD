import { MutableRefObject, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { api, Channel, ChatMessageBase, Message } from '../api'
import { OutgoingMessage } from '../components/MessageInput'
import { useGateway } from '../gateway'
import { outbox } from '../outbox'

/** Куда должна встать прокрутка ленты сразу после открытия канала — см.
 * loadChannelWindow. Ключ (`key`) — повод для MessageList переприменить цель:
 * он меняется при каждом переключении канала, даже если target тот же самый
 * ('bottom' на 'bottom' не был бы отдельным React-обновлением сам по себе). */
export interface ScrollAnchor {
  key: string
  target: 'bottom' | { messageId: number }
}

/** Сколько сообщений ДО последнего прочитанного подгружать для контекста —
 * чтобы канал открывался не голым первым непрочитанным сообщением у самого
 * края экрана, а с частью уже читанной истории над ним, как обычно и
 * выглядит «продолжить с того места». Меньше обычной страницы: это не лента
 * для чтения назад, а только подложка под точку возврата. */
const CONTEXT_PAGE_SIZE = 30

/** Решает, что показать при заходе в канал, и с какой прокруткой.
 *
 * Курсор прочтения (chat.models.ChannelReadState на бэкенде) либо ещё не
 * заводили (null — первый заход или курсор существует только с этого
 * момента), либо указывает на последнее увиденное сообщение:
 *
 *   * курсора нет — канал считается прочитанным по факту открытия (иначе
 *     первый же заход в старый канал с историей пытался бы прокрутить к её
 *     началу, а не к низу); заодно отмечаем текущий хвост, чтобы СЛЕДУЮЩИЙ
 *     заход уже отличал по-настоящему новое от старого;
 *   * после курсора ничего нового — как и раньше, последняя страница, низ;
 *   * есть непрочитанное — подгружаем его (?after=курсор) плюс немного
 *     истории до него для контекста (?before=курсор+1), прокрутка — на
 *     первое непрочитанное. Дальше этого окна пагинации нет (её нет вообще
 *     нигде в приложении — история за пределами одной страницы недостижима
 *     и для обычного скролла), так что это не регресс, а то же самое
 *     ограничение, что и всегда, применённое и здесь.
 */
async function loadChannelWindow(
  channelId: number,
): Promise<{ loaded: Message[]; target: ScrollAnchor['target'] }> {
  try {
    const read = await api.channelReadState(channelId).catch(
      () => ({ last_read_message_id: null }),
    )
    if (read.last_read_message_id == null) {
      const latest = await api.messages(channelId)
      const last = latest[latest.length - 1]
      if (last) void api.markChannelRead(channelId, last.id).catch(() => {})
      return { loaded: latest, target: 'bottom' }
    }
    const unread = await api.messages(channelId, { after: read.last_read_message_id })
    if (unread.length === 0) {
      return { loaded: await api.messages(channelId), target: 'bottom' }
    }
    const context = await api.messages(channelId, {
      before: read.last_read_message_id + 1,
      limit: CONTEXT_PAGE_SIZE,
    })
    // Разрезы курсора не пересекаются по построению (before берёт id <=
    // курсора, after — id > курсора), склеивать через Set незачем.
    return { loaded: [...context, ...unread], target: { messageId: unread[0].id } }
  } catch {
    return { loaded: [], target: 'bottom' }
  }
}

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

  // Куда прокрутить ленту сразу после открытия канала — см. ScrollAnchor.
  // null, пока решение ещё не приехало (первый рендер нового канала):
  // MessageList в этот момент ничего не делает и ждёт следующего значения.
  const [scrollAnchor, setScrollAnchor] = useState<ScrollAnchor | null>(null)
  // Счётчик запросов на загрузку — от гонки, когда канал переключили ещё раз,
  // пока предыдущая загрузка (два-три последовательных запроса, см.
  // loadChannelWindow) ещё летела: без него более старый ответ, доехавший
  // позже, подменил бы уже загруженные сообщения НОВОГО канала своими.
  const loadTokenRef = useRef(0)
  // Последний id, за который уже отправлена отметка «прочитано», — чтобы
  // повторные вызовы handleReachedBottom с тем же (или более старым, при
  // гонке сетевых ответов) id не гоняли лишний POST впустую.
  const lastMarkedIdRef = useRef<number | null>(null)

  // История сообщений при смене текстового канала. useLayoutEffect — по той
  // же причине, что и у аналогичного эффекта для ЛС: без него editTarget
  // уходящего канала на миг мелькнул бы в новом.
  useLayoutEffect(() => {
    setReplyTarget(null)
    const key = currentChannel && currentChannel.kind === 'text' ? `channel-${currentChannel.id}` : null
    const restored = key ? pendingEditsRef.current.get(key) ?? null : null
    setEditTargetTracked(restored)
    lastMarkedIdRef.current = null
    const token = ++loadTokenRef.current
    if (!currentChannel || currentChannel.kind !== 'text') {
      setMessages([])
      setScrollAnchor(null)
    } else {
      const openedChannelId = currentChannel.id
      setScrollAnchor(null)
      void loadChannelWindow(openedChannelId).then(({ loaded, target }) => {
        // Канал переключили ещё раз, пока это летало — эти данные больше
        // никому не нужны, а поставить их значило бы мигнуть чужим каналом.
        if (loadTokenRef.current !== token) return
        setMessages(loaded)
        setScrollAnchor({ key: `channel-${openedChannelId}`, target })
      })
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

  /** Лента дочитана до конца (см. MessageList) — продвигает курсор прочтения
   * на бэкенде. Не ждётся и не показывает ошибок: неудавшаяся отметка не
   * должна мешать читать канал, просто при следующем заходе он снова
   * покажется как есть — не хуже, чем было бы без этой фичи вовсе. */
  const handleReachedBottom = useCallback(
    (messageId: number) => {
      if (channelId == null) return
      if (lastMarkedIdRef.current != null && lastMarkedIdRef.current >= messageId) return
      lastMarkedIdRef.current = messageId
      void api.markChannelRead(channelId, messageId).catch(() => {})
    },
    [channelId],
  )

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
    scrollAnchor, handleReachedBottom,
    handleSend, handleToggleReaction, handleDeleteMessage,
    handleReplyRequest, handleEditRequest, handleSaveEdit, handleTogglePin,
  }
}
