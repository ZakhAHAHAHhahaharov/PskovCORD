import {
  MutableRefObject, useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react'
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

/** Запрос «покажи вот это сообщение» — из мини-чата панели модератора (см.
 * ModeratorMessages). token меняется на каждый клик, даже по тому же самому
 * сообщению: повторный переход должен снова прокрутить и подсветить, а без
 * отдельного счётчика одинаковый запрос не был бы новым значением. */
export interface MessageJumpRequest {
  channelId: number
  messageId: number
  token: number
}

/** Сколько сообщений подгружать по каждую сторону от цели перехода. Симметрично
 * и заметно меньше страницы: нужен контекст вокруг («что там вообще
 * происходило»), а не вся история канала. */
const JUMP_CONTEXT_SIZE = 30

/** Окно истории ВОКРУГ конкретного сообщения — то, чего loadChannelWindow не
 * умеет: тот открывает канал «где остановился», а здесь цель произвольная и
 * может лежать сколь угодно глубоко.
 *
 * before=<id+1> захватывает и само сообщение (фильтр строгий, id < before),
 * after=<id> — только то, что новее; разрезы не пересекаются по построению,
 * склеивать через Set незачем — ровно тот же приём, что в loadChannelWindow.
 */
async function loadMessageWindow(
  channelId: number,
  messageId: number,
): Promise<Message[]> {
  try {
    const [before, after] = await Promise.all([
      api.messages(channelId, { before: messageId + 1, limit: JUMP_CONTEXT_SIZE }),
      api.messages(channelId, { after: messageId, limit: JUMP_CONTEXT_SIZE }),
    ])
    return [...before, ...after]
  } catch {
    return []
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
  /** Куда перепрыгнуть из панели модератора — см. MessageJumpRequest. */
  jumpRequest: MessageJumpRequest | null = null,
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
  // Сообщение, к которому только что перепрыгнули, — подсвечивается на пару
  // секунд, иначе после скачка непонятно, ради чего именно листали.
  const [highlightMessageId, setHighlightMessageId] = useState<number | null>(null)
  // token последнего ОТРАБОТАННОГО перехода — не даёт применить его повторно
  // (эффект перезапускается и от смены channelId).
  const appliedJumpRef = useRef(0)
  // Читается в эффекте смены канала, который намеренно не держит запрос
  // перехода в зависимостях (иначе он перезапускался бы на каждый прыжок и
  // сбрасывал черновик ответа).
  const jumpRef = useRef<MessageJumpRequest | null>(jumpRequest)
  jumpRef.current = jumpRequest

  // История сообщений при смене текстового канала. useLayoutEffect — по той
  // же причине, что и у аналогичного эффекта для ЛС: без него editTarget
  // уходящего канала на миг мелькнул бы в новом.
  useLayoutEffect(() => {
    setReplyTarget(null)
    // Сообщения есть у канала любого вида: у текстового, у ветки и у
    // голосового (встроенный чат звонка, см. AppShellChat) — отдельной
    // проверки на kind здесь поэтому нет вовсе.
    const key = currentChannel ? `channel-${currentChannel.id}` : null
    const restored = key ? pendingEditsRef.current.get(key) ?? null : null
    setEditTargetTracked(restored)
    lastMarkedIdRef.current = null
    const token = ++loadTokenRef.current
    if (!currentChannel) {
      setMessages([])
      setScrollAnchor(null)
    } else {
      const openedChannelId = currentChannel.id
      setScrollAnchor(null)
      // В канал заходят РАДИ конкретного сообщения (переход из панели
      // модератора) — окно вокруг него загрузит эффект перехода ниже.
      // Обычная загрузка «где остановился» здесь не только лишняя, но и
      // вредная: два запроса гонялись бы за один и тот же setMessages.
      const pendingJump = jumpRef.current
      if (
        pendingJump
        && pendingJump.channelId === openedChannelId
        && pendingJump.token !== appliedJumpRef.current
      ) {
        setMessages([])
        return
      }
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

  // Переход к сообщению из панели модератора. Отдельным эффектом от смены
  // канала: прыгать можно и НЕ выходя из текущего канала (тогда тот эффект
  // вообще не сработает), а заодно так переход не сбрасывает черновик ответа
  // и незавершённое редактирование.
  //
  // Ждёт, пока channelId станет тем самым: клик переключает канал и ставит
  // запрос одним обновлением, но до перерисовки channelId здесь ещё старый.
  useEffect(() => {
    if (!jumpRequest || jumpRequest.token === appliedJumpRef.current) return
    if (channelId !== jumpRequest.channelId) return
    appliedJumpRef.current = jumpRequest.token
    const token = ++loadTokenRef.current
    void loadMessageWindow(jumpRequest.channelId, jumpRequest.messageId).then((loaded) => {
      if (loadTokenRef.current !== token) return
      setMessages(loaded)
      setScrollAnchor({
        key: `jump-${jumpRequest.token}`,
        target: { messageId: jumpRequest.messageId },
      })
      setHighlightMessageId(jumpRequest.messageId)
    })
  }, [jumpRequest, channelId])

  // Подсветка гаснет сама. Таймер привязан к id, а не ставится в момент
  // перехода: повторный прыжок к тому же сообщению перезапустит эффект и
  // продлит подсветку, а не оставит её от прошлого раза догорать.
  useEffect(() => {
    if (highlightMessageId == null) return
    const id = window.setTimeout(() => setHighlightMessageId(null), 2600)
    return () => window.clearTimeout(id)
  }, [highlightMessageId])

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
      poll: message.poll,
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
    scrollAnchor, handleReachedBottom, highlightMessageId,
    handleSend, handleToggleReaction, handleDeleteMessage,
    handleReplyRequest, handleEditRequest, handleSaveEdit, handleTogglePin,
  }
}
