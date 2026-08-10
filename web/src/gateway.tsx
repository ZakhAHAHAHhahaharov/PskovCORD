import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react'
import { ensureAccessToken, getToken, UserStatus } from './api'
import type { OutgoingPoll } from './outbox'

type Handler = (payload: any) => void

/** Состояние связи с gateway — для индикатора в интерфейсе.
 *
 * 'online'     — сокет открыт и отвечает на хартбит;
 * 'connecting' — первое подключение или попытка переподключиться прямо сейчас;
 * 'offline'    — попытки проваливаются, ждём следующей по backoff'у. */
export type ConnectionState = 'online' | 'connecting' | 'offline'

/** Что нужно серверу для создания сообщения сверх самого текста.
 *
 * nonce — метка ПОПЫТКИ отправки (см. web/src/outbox.ts): по ней приходит
 * подтверждение доставки и по ней же сервер узнаёт ретрай, чтобы не создать
 * дубль. attachmentIds — id уже загруженных файлов (api.uploadAttachment):
 * сами файлы через сокет не идут, он тут один на всё приложение. */
export interface SendMessageOptions {
  replyTo?: number | null
  attachmentIds?: string[]
  nonce?: string
  /** Опрос, создаваемый вместе с сообщением. На сервере он появляется в ОДНОЙ
   * транзакции с ним (см. chat.consumers._attach_poll): сообщение «Кто идёт?»
   * без вариантов ответа — не то, что человек отправлял. */
  poll?: OutgoingPoll
}

interface GatewayCtx {
  on: (op: string, handler: Handler) => () => void
  sendMessage: (channelId: number, content: string, opts?: SendMessageOptions) => void
  deleteMessage: (messageId: number) => void
  editMessage: (messageId: number, content: string) => void
  /** Закрепить/открепить сообщение в текстовом канале — нужно право
   * "delete_messages" (модерация сообщений), проверяется на сервере. */
  pinMessage: (messageId: number, pinned: boolean) => void
  /** Поставить/снять свою реакцию на сообщение канала. */
  addReaction: (messageId: number, emoji: string) => void
  removeReaction: (messageId: number, emoji: string) => void
  voiceJoin: (channelId: number) => void
  voiceLeave: () => void
  voiceMuteUpdate: (muted: boolean, deafened: boolean) => void
  voiceScreenShareUpdate: (sharing: boolean) => void
  voiceTopicUpdate: (topic: string) => void
  /** Отключить участника от ЕГО текущего голосового канала — нужно право
   * "manage_members", проверяется на сервере (см. chat.consumers). */
  voiceDisconnectUser: (userId: number) => void
  /** Переместить участника ИЗ его текущего голосового канала В указанный —
   * перетаскивание строки участника на другой канал (см. ChannelSidebar).
   * Нужно право "manage_members" (проверяется на сервере); себя самого этим
   * не двигают — см. useVoiceCall.handleMoveVoiceUser. */
  voiceMoveUser: (userId: number, channelId: number) => void
  /** Начать голосование за мут участника, который сейчас в том же голосовом
   * канале (право не нужно — может любой участник канала). */
  voiceMuteVoteStart: (targetUserId: number) => void
  /** Проголосовать в активном голосовании канала, в котором мы сейчас. */
  voiceMuteVoteCast: (forMute: boolean) => void
  /** Попросить участника того же голосового канала включить демонстрацию —
   * персональный тихий пинг, слышен только адресату (voice_screen_share_requested). */
  voiceRequestScreenShare: (targetUserId: number) => void
  /** «Разбудить мальчика» — участника того же голосового канала, у которого
   * СЕЙЧАС выключен микрофон или звук (сервер молча игнорирует иначе, см.
   * chat.consumers._handle_voice_wake_user). В отличие от
   * voiceRequestScreenShare — не тихий пинг, а нарочно противный звук. */
  voiceWakeUser: (targetUserId: number) => void
  /** Проиграть звук соундборда всем в моём голосовом канале. Канал сервер
   * берёт из presence сам — прислать чужой нельзя. */
  soundboardPlay: (soundId: number) => void
  /** Отдать/переставить свой голос. Пустой список снимает голос вовсе;
   * повторный клик по уже выбранному варианту делает то же самое. */
  pollVote: (pollId: number, optionIds: number[]) => void
  /** Закрыть опрос досрочно — автор сообщения или модерация сообщений.
   * Обратной операции нет намеренно (см. chat.consumers). */
  pollClose: (pollId: number) => void
  /** «Я печатаю здесь». Зовётся часто (на набор текста), поэтому вызывающий
   * обязан троттлить сам — см. shouldSendTyping в web/src/typing.ts. */
  typingStart: (channelId: number) => void
  dmTypingStart: (conversationId: number) => void
  setStatus: (status: UserStatus) => void
  dmSendMessage: (
    conversationId: number,
    content: string,
    opts?: SendMessageOptions,
  ) => void
  dmDeleteMessage: (messageId: number) => void
  dmEditMessage: (messageId: number, content: string) => void
  /** Реакции в личке/группе — отдельные оп'ы, потому что id сообщений в
   * ConversationMessage и Message нумеруются независимо (см. backend). */
  dmAddReaction: (messageId: number, emoji: string) => void
  dmRemoveReaction: (messageId: number, emoji: string) => void
  /** voiceLeave/voiceMuteUpdate/voiceScreenShareUpdate — те же клиентские
   * op'ы для звонка в диалоге/группе (сервер сам различает по текущей
   * комнате, см. chat.consumers._send_to_room_group). */
  dmVoiceJoin: (conversationId: number) => void
}

const Ctx = createContext<GatewayCtx>(null as unknown as GatewayCtx)
export const useGateway = () => useContext(Ctx)

// Состояние связи живёт в ОТДЕЛЬНОМ контексте, а не полем в GatewayCtx.
// Значение GatewayCtx намеренно неизменно всю жизнь провайдера (см. useMemo
// ниже) — положи статус туда, и каждый обрыв/реконнект перерисовывал бы всех
// потребителей useGateway(), то есть половину приложения. Здесь же подписчик
// ровно один — индикатор связи.
const StatusCtx = createContext<ConnectionState>('connecting')
export const useConnectionState = () => useContext(StatusCtx)

// Хартбит: пока сокет открыт, шлём {"op":"ping"} раз в PING_INTERVAL — сервер
// обновляет TTL "жив" (presence.heartbeat, 5 минут) и раз в минуту подчищает
// тех, чей TTL истёк (chat.heartbeat_sweep) — страховка на случай, если WS
// оборвался без close-фрейма (сон ноутбука, краш вкладки) и обычный
// disconnect() так и не пришёл. Интервал заметно короче TTL — несколько
// попыток про запас на случай троттлинга фоновой вкладки браузером.
const PING_INTERVAL_MS = 30 * 1000

// Сколько ждём {"op":"pong"} (или вообще любого байта от сервера) в ответ на
// свой ping, прежде чем счесть сокет мёртвым и закрыть его руками.
//
// Зачем вообще: соединение умирает НЕ только close-фреймом. При смене сети
// (Wi-Fi <-> LTE), NAT-таймауте роутера или выходе ноутбука из сна TCP
// остаётся «полуоткрытым»: close не приходит никогда, readyState у браузера
// так и висит OPEN, onclose не срабатывает — и весь механизм реконнекта ниже
// просто не запускается. Снаружи это выглядит как «приложение зависло»:
// сообщения не приходят, отправленные молча уходят в никуда, лечится только
// перезагрузкой страницы. Своих ping/pong-фреймов протокола браузер в JS не
// показывает, поэтому живость приходится проверять на уровне приложения.
const PONG_TIMEOUT_MS = 10 * 1000

// Реконнект с экспоненциальной задержкой и джиттером. Раньше здесь стоял
// фиксированный setTimeout(connect, 2000): без потолка, без джиттера и без
// учёта причины обрыва. Если сервер рвал соединение из-за протухшего токена
// или просто перезапускался, все вкладки всех клиентов долбились в него раз в
// две секунды бесконечно и разом. Тот же паттерн уже был реализован в
// voice.ts для SFU — здесь он просто не был переиспользован.
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

// Сообщения, отправленные при закрытом сокете, копятся до реконнекта. Очередь
// ограничена: при долгом обрыве она иначе растёт неограниченно, а вываливать
// на сервер тысячу отложенных операций разом всё равно не стоит.
const MAX_QUEUED_MESSAGES = 100

// Пусто => same-origin (ws/wss от текущего хоста). Для dev задаётся в web/.env.
const ENV_WS = import.meta.env.VITE_WS_URL
const WS: string =
  ENV_WS !== undefined && ENV_WS !== ''
    ? ENV_WS
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

// Стабильный id этой вкладки — сервер сверяет его в chat.consumers
// (_kick_other_devices/GatewayConsumer.connection_id), чтобы отличить
// "реально другое устройство зашло в голос" от "эта же вкладка на миг
// подключилась ДВУМЯ WS-сокетами разом" (обрыв+реконнект, двойной mount
// React StrictMode в деве) — без стабильного id второй случай выглядел бы
// для этой проверки как другое устройство и кикал бы сам себя. sessionStorage,
// не module-переменная: переживает и обычный reconnect, и полный reload
// страницы в той же вкладке (значение живёт, пока вкладка не закрыта).
function getDeviceId(): string {
  const KEY = 'pskovcord:device_id'
  try {
    let id = sessionStorage.getItem(KEY)
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    // sessionStorage недоступен (приватный режим и т.п.) — не критично,
    // просто теряем устойчивость к гонке реконнекта для этой вкладки.
    return crypto.randomUUID()
  }
}
const DEVICE_ID = getDeviceId()

export function GatewayProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlers = useRef<Map<string, Set<Handler>>>(new Map())
  const queue = useRef<string[]>([])
  const closed = useRef(false)
  const attempt = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Когда сервер в последний раз прислал хоть что-нибудь, и когда мы в
  // последний раз просили его отозваться. Пара нужна watchdog'у ниже: «ответ
  // пришёл ПОСЛЕ вопроса» — единственный доступный признак живого сокета.
  const lastSeenAt = useRef(0)
  const pingSentAt = useRef(0)
  const pongTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [state, setState] = useState<ConnectionState>('connecting')

  const connect = useCallback(async () => {
    if (closed.current) return
    setState((prev) => (prev === 'online' ? 'connecting' : prev))
    // Не getToken(): у сокета нет пути «получил 401 — обнови и повтори», он
    // просто закрывается, и вкладка, проспавшая дольше жизни access-токена,
    // переподключалась бы протухшим токеном бесконечно. ensureAccessToken
    // обновляет его заранее (см. api.ts).
    const token = await ensureAccessToken()
    if (!token || closed.current) return

    const ws = new WebSocket(`${WS}/ws/gateway?token=${token}&device_id=${DEVICE_ID}`)
    wsRef.current = ws

    ws.onopen = () => {
      attempt.current = 0
      lastSeenAt.current = Date.now()
      setState('online')
      queue.current.forEach((m) => ws.send(m))
      queue.current = []
    }
    ws.onmessage = (e) => {
      // Любое сообщение — доказательство живости, не только pong.
      lastSeenAt.current = Date.now()
      try {
        const data = JSON.parse(e.data)
        // pong существует ровно ради строки выше: подписчиков у него нет и
        // не предполагается, дальше его нести незачем.
        if (data.op === 'pong') return
        handlers.current.get(data.op)?.forEach((h) => h(data))
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      wsRef.current = null
      if (pongTimer.current) clearTimeout(pongTimer.current)
      pongTimer.current = null
      if (closed.current) return
      // Токена больше нет (разлогинились или сессия окончательно истекла) —
      // переподключаться некуда и незачем.
      if (!getToken()) return
      attempt.current += 1
      // Первый обрыв — это чаще всего рестарт бэкенда или моргнувший вайфай,
      // и он чинится за секунду; показывать из-за него тревожную полосу
      // незачем. 'offline' — только когда попытки уже проваливаются подряд.
      setState(attempt.current >= 2 ? 'offline' : 'connecting')
      const backoff = Math.min(
        RECONNECT_BASE_MS * 2 ** (attempt.current - 1),
        RECONNECT_MAX_MS,
      )
      // Джиттер: без него после рестарта сервера все клиенты приходят
      // ровно одновременно и роняют его повторно.
      const delay = backoff * (0.5 + Math.random() * 0.5)
      reconnectTimer.current = setTimeout(() => void connect(), delay)
    }
  }, [])

  /** Спросить сервер, жив ли он, и назначить срок ответа.
   *
   * Сам ping заодно продлевает presence-TTL (см. chat.presence.heartbeat) —
   * поэтому отдельного «тихого» пинга для watchdog'а не нужно. */
  const probe = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ op: 'ping' }))
    pingSentAt.current = Date.now()
    if (pongTimer.current) clearTimeout(pongTimer.current)
    pongTimer.current = setTimeout(() => {
      pongTimer.current = null
      const sock = wsRef.current
      if (!sock || sock.readyState !== WebSocket.OPEN) return
      // Ответили (неважно чем — pong или чужим сообщением) — сокет жив.
      if (lastSeenAt.current >= pingSentAt.current) return
      // Молчит. close() руками: onclose выше запустит обычный реконнект —
      // сам по себе такой сокет не закроется никогда.
      sock.close()
    }, PONG_TIMEOUT_MS)
  }, [])

  /** Переподключиться немедленно, не досиживая backoff.
   *
   * Вызывается, когда браузер сообщил о возврате к жизни: вернулась сеть,
   * вкладку снова открыли, страницу восстановили из bfcache. Без этого
   * проснувшийся ноутбук ждал бы до 30 секунд на ровном месте — а с мёртвым
   * «полуоткрытым» сокетом (см. PONG_TIMEOUT_MS) не переподключился бы вовсе,
   * потому что onclose там не срабатывает никогда. */
  const wake = useCallback(() => {
    if (closed.current || !getToken()) return
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Сокет с виду жив — но именно после сна/офлайна он и бывает зомби.
      // Не рвём вслепую (обычно он исправен, а лишний реконнект — это ещё и
      // перечитывание истории в каждой открытой ленте, см. useGatewayEvents),
      // а спрашиваем: не ответит за PONG_TIMEOUT_MS — закроется сам.
      probe()
      return
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) return
    // Ждём по backoff'у — отменяем ожидание и идём сразу.
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    reconnectTimer.current = null
    attempt.current = 0
    void connect()
  }, [connect, probe])

  useEffect(() => {
    closed.current = false
    void connect()
    return () => {
      closed.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
      if (pongTimer.current) clearTimeout(pongTimer.current)
      pongTimer.current = null
      wsRef.current?.close()
    }
  }, [connect])

  useEffect(() => {
    const interval = setInterval(probe, PING_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [probe])

  // События «мы снова живы». visibilitychange — возврат на вкладку (сюда же
  // попадает пробуждение из сна: браузер морозит таймеры фоновых вкладок, и
  // хартбит выше мог не тикать вовсе). pageshow — восстановление страницы из
  // bfcache, при котором сокет уже мёртв, а onclose так и не пришёл.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') wake()
    }
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', wake)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [wake])

  const raw = useCallback((obj: unknown) => {
    const msg = JSON.stringify(obj)
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
      return
    }
    if (queue.current.length >= MAX_QUEUED_MESSAGES) queue.current.shift()
    queue.current.push(msg)
  }, [])

  const on = useCallback((op: string, handler: Handler) => {
    if (!handlers.current.has(op)) handlers.current.set(op, new Set())
    handlers.current.get(op)!.add(handler)
    return () => {
      handlers.current.get(op)?.delete(handler)
    }
  }, [])

  // useMemo, а не новый объект на каждый рендер: без него КАЖДЫЙ рендер
  // провайдера менял значение контекста и заставлял перерисовываться всех
  // потребителей useGateway().
  /** Опрос в том виде, в каком его ждёт сервер (snake_case, см.
   * chat.consumers._read_poll). undefined — опроса нет, и поля в payload'е
   * тоже быть не должно. */
  const pollPayload = (poll: OutgoingPoll | undefined) =>
    poll && {
      question: poll.question,
      options: poll.options,
      multiple: poll.multiple,
      duration_hours: poll.durationHours ?? null,
    }

  const value: GatewayCtx = useMemo(() => ({
    on,
    sendMessage: (channelId, content, opts) =>
      raw({
        op: 'send_message',
        channel_id: channelId,
        content,
        reply_to: opts?.replyTo ?? null,
        attachment_ids: opts?.attachmentIds ?? [],
        nonce: opts?.nonce ?? null,
        poll: pollPayload(opts?.poll),
      }),
    deleteMessage: (messageId) => raw({ op: 'delete_message', message_id: messageId }),
    editMessage: (messageId, content) =>
      raw({ op: 'edit_message', message_id: messageId, content }),
    pinMessage: (messageId, pinned) =>
      raw({ op: 'pin_message', message_id: messageId, pinned }),
    addReaction: (messageId, emoji) =>
      raw({ op: 'add_reaction', message_id: messageId, emoji }),
    removeReaction: (messageId, emoji) =>
      raw({ op: 'remove_reaction', message_id: messageId, emoji }),
    voiceJoin: (channelId) => raw({ op: 'voice_join', channel_id: channelId }),
    voiceLeave: () => raw({ op: 'voice_leave' }),
    voiceMuteUpdate: (muted, deafened) =>
      raw({ op: 'voice_mute_update', muted, deafened }),
    voiceScreenShareUpdate: (sharing) =>
      raw({ op: 'voice_screen_share_update', sharing }),
    voiceTopicUpdate: (topic) => raw({ op: 'voice_topic_update', topic }),
    voiceDisconnectUser: (userId) => raw({ op: 'voice_disconnect_user', user_id: userId }),
    voiceMoveUser: (userId, channelId) =>
      raw({ op: 'voice_move_user', user_id: userId, channel_id: channelId }),
    voiceMuteVoteStart: (targetUserId) =>
      raw({ op: 'voice_mute_vote_start', target_user_id: targetUserId }),
    voiceMuteVoteCast: (forMute) => raw({ op: 'voice_mute_vote_cast', for: forMute }),
    voiceRequestScreenShare: (targetUserId) =>
      raw({ op: 'voice_request_screen_share', target_user_id: targetUserId }),
    voiceWakeUser: (targetUserId) =>
      raw({ op: 'voice_wake_user', target_user_id: targetUserId }),
    soundboardPlay: (soundId) => raw({ op: 'soundboard_play', sound_id: soundId }),
    pollVote: (pollId, optionIds) =>
      raw({ op: 'poll_vote', poll_id: pollId, option_ids: optionIds }),
    pollClose: (pollId) => raw({ op: 'poll_close', poll_id: pollId }),
    typingStart: (channelId) => raw({ op: 'typing_start', channel_id: channelId }),
    dmTypingStart: (conversationId) =>
      raw({ op: 'typing_start', conversation_id: conversationId }),
    setStatus: (status) => raw({ op: 'set_status', status }),
    dmSendMessage: (conversationId, content, opts) =>
      raw({
        op: 'dm_send_message',
        conversation_id: conversationId,
        content,
        reply_to: opts?.replyTo ?? null,
        attachment_ids: opts?.attachmentIds ?? [],
        nonce: opts?.nonce ?? null,
        poll: pollPayload(opts?.poll),
      }),
    dmDeleteMessage: (messageId) => raw({ op: 'dm_delete_message', message_id: messageId }),
    dmEditMessage: (messageId, content) =>
      raw({ op: 'dm_edit_message', message_id: messageId, content }),
    dmAddReaction: (messageId, emoji) =>
      raw({ op: 'dm_add_reaction', message_id: messageId, emoji }),
    dmRemoveReaction: (messageId, emoji) =>
      raw({ op: 'dm_remove_reaction', message_id: messageId, emoji }),
    dmVoiceJoin: (conversationId) =>
      raw({ op: 'dm_voice_join', conversation_id: conversationId }),
  }), [on, raw])

  return (
    <Ctx.Provider value={value}>
      <StatusCtx.Provider value={state}>{children}</StatusCtx.Provider>
    </Ctx.Provider>
  )
}
