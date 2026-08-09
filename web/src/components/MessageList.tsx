import {
  Fragment, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState,
  MouseEvent as ReactMouseEvent,
} from 'react'
import {
  AlertCircle, Check, ChevronDown, ChevronRight, Clock, MessagesSquare, Pin, PinOff,
  Reply, Pencil, RotateCw, SmilePlus, Trash2,
} from 'lucide-react'
import {
  Channel, ChatMessageBase, Conversation, MentionCandidate, MessageSystemKind, Server,
} from '../api'
import { useContextMenuState } from '../contextMenuStack'
import { escapeRegExp, WORD_CHAR } from '../mentions'
import { styledNameProps } from '../nameStyle'
import { displayNameOf, useNicknamesVersion } from '../nicknames'
import { DeliveryStatus, DELIVERY_STATUS_PRESENTATION, outbox } from '../outbox'
import { EMOJI_TOKEN_RE, QUICK_REACTIONS, STICKER_TOKEN_RE, customEmojiKey } from '../emoji'
import { recordReactionUse } from '../reactionFrequency'
import Avatar from './Avatar'
import CustomEmojiImage from './CustomEmojiImage'
import StickerImage from './StickerImage'
import DeleteMessageModal from './DeleteMessageModal'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'
import ForwardMessageModal from './ForwardMessageModal'
import MessageAttachments from './MessageAttachments'
import MessageContextMenu from './MessageContextMenu'
import MessageReactions from './MessageReactions'
import MessageReactionsModal from './MessageReactionsModal'
import ServerInviteCard from './ServerInviteCard'
import { ProfilePopupUser } from './MiniProfilePopup'

/** Насколько близко к низу нужно стоять, чтобы ЧУЖОЕ сообщение утащило ленту
 * вниз. В пикселях, а не в долях: смысл здесь «мы фактически внизу», и он не
 * зависит от того, насколько длинная история выше. */
const OTHERS_BOTTOM_PX = 150

/** До какой доли прокрутки СВОЁ отправленное сообщение всё ещё утаскивает
 * ленту вниз (0.3 = промотано вверх не больше чем на 30%). */
const MINE_SCROLLED_UP_MAX = 0.3

/** Сколько времени у только что подтверждённого удаления остаётся кнопка
 * "Отменить" — после этого DELETE уходит на сервер по-настоящему и отмены
 * уже не будет (см. startPendingDelete). */
const PENDING_DELETE_MS = 10_000

/** Разбивает текст сообщения на обычные куски и кликабельные "@Ник" —
 * только для ников, которые реально есть среди mentionCandidates (ростер
 * сервера/участники диалога), иначе любое случайное "@слово" в чужом
 * сообщении подсвечивалось бы кнопкой в никуда. Граница токена — та же, что
 * и при определении "упомянули ли меня" (см. web/src/mentions.ts) — то же
 * "@Ник" не должно совпадать внутри "@Никита" или в середине email-адреса. */
function renderMentions(
  content: string,
  candidates: MentionCandidate[],
  onClick: (candidate: MentionCandidate, e: ReactMouseEvent) => void,
): ReactNode {
  if (candidates.length === 0) return content
  const byName = new Map(candidates.map((c) => [c.username.toLowerCase(), c]))
  const pattern = new RegExp(
    `(^|[^${WORD_CHAR}@])@(${candidates.map((c) => escapeRegExp(c.username)).join('|')})(?![${WORD_CHAR}])`,
    'gi',
  )
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(content))) {
    const [, before, name] = match
    const start = match.index + before.length
    if (start > lastIndex) nodes.push(content.slice(lastIndex, start))
    const candidate = byName.get(name.toLowerCase())
    if (candidate) {
      nodes.push(
        <button
          key={`mention-${key++}`}
          type="button"
          className="mention-pill"
          onClick={(e) => {
            e.stopPropagation()
            onClick(candidate, e)
          }}
        >
          @{name}
        </button>,
      )
    } else {
      nodes.push(`@${name}`)
    }
    lastIndex = start + 1 + name.length
  }
  if (lastIndex === 0) return content
  if (lastIndex < content.length) nodes.push(content.slice(lastIndex))
  return nodes
}

/** Сколько кастомных эмодзи в сообщении считается «сообщением из одних
 * эмодзи» — тогда они рисуются крупно, как в Discord. Порог, а не точное
 * «текста нет вовсе»: «<:кот:1> <:кот:1>» с пробелами между — всё ещё оно. */
const JUMBO_EMOJI_LIMIT = 6

/** Текст сообщения целиком: кастомные эмодзи картинками, @упоминания
 * кнопками, остальное как есть.
 *
 * Порядок именно такой: сначала вырезаются токены <:имя:id>, и только их
 * ОСТАТКИ уходят в renderMentions. Наоборот было бы неверно — имя эмодзи
 * может совпасть с ником, и «@ник» внутри токена превратился бы в кнопку,
 * разорвав токен пополам. */
function renderInline(
  content: string,
  candidates: MentionCandidate[],
  onMentionClick: (candidate: MentionCandidate, e: ReactMouseEvent) => void,
): ReactNode {
  if (!content.includes('<')) return renderMentions(content, candidates, onMentionClick)
  const matches = [...content.matchAll(EMOJI_TOKEN_RE)]
  if (matches.length === 0) return renderMentions(content, candidates, onMentionClick)

  // Крупно — только если КРОМЕ эмодзи в сообщении ничего нет (пробелы не в
  // счёт): «зацени <:кот:1>» должен остаться строчным, иначе эмодзи ломает
  // высоту строки прямо посреди фразы.
  const jumbo =
    matches.length <= JUMBO_EMOJI_LIMIT &&
    content.replace(EMOJI_TOKEN_RE, '').trim() === ''

  const nodes: ReactNode[] = []
  let lastIndex = 0
  matches.forEach((match, i) => {
    const start = match.index ?? 0
    if (start > lastIndex) {
      nodes.push(
        <Fragment key={`t-${i}`}>
          {renderMentions(content.slice(lastIndex, start), candidates, onMentionClick)}
        </Fragment>,
      )
    }
    nodes.push(
      <CustomEmojiImage
        key={`e-${i}`}
        id={Number(match[3])}
        className={jumbo ? 'custom-emoji-jumbo' : 'custom-emoji-inline'}
      />,
    )
    lastIndex = start + match[0].length
  })
  if (lastIndex < content.length) {
    nodes.push(
      <Fragment key="t-last">
        {renderMentions(content.slice(lastIndex), candidates, onMentionClick)}
      </Fragment>,
    )
  }
  return nodes
}

/** Сторона стикера в ленте. Крупно и без вариантов: стикер и есть реплика, а
 * не украшение к тексту — мельче он читался бы как большой эмодзи. */
const STICKER_SIZE = 160

/** Насколько «свежим» считается сообщение, у которого стикер играет сам. По
 * времени создания, а не по «это сообщение только что отрисовалось»: при
 * входе в канал отрисовывается вся история разом, и по второму признаку
 * ожили бы все стикеры сразу. */
const FRESH_MESSAGE_MS = 15_000

function isFreshMessage(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() < FRESH_MESSAGE_MS
}

/** Текст сообщения целиком: стикеры картинками, кастомные эмодзи картинками,
 * @упоминания кнопками, остальное как есть.
 *
 * Стикеры отделяются ПЕРВЫМИ, и только их остатки уходят в разбор эмодзи и
 * упоминаний: токен стикера ("<sticker:42>") в чужие регулярки не попадает, но
 * порядок всё равно важен — он держит стикер блоком, а не строчкой посреди
 * фразы. Обычно, впрочем, кроме него в сообщении ничего и нет: стикер уходит
 * отдельной репликой (см. MessageInput.sendSticker), а текст рядом с ним
 * появляется только если его дописали правкой. */
function renderContent(
  content: string,
  candidates: MentionCandidate[],
  onMentionClick: (candidate: MentionCandidate, e: ReactMouseEvent) => void,
  /** Проиграть анимацию один раз сразу — у только что пришедшего сообщения.
   * Иначе прокрутка истории запускала бы анимацию у всех стикеров разом. */
  stickerAutoPlay = false,
): ReactNode {
  if (!content.includes('<sticker:')) {
    return renderInline(content, candidates, onMentionClick)
  }
  const matches = [...content.matchAll(STICKER_TOKEN_RE)]
  const nodes: ReactNode[] = []
  let lastIndex = 0
  matches.forEach((match, i) => {
    const start = match.index ?? 0
    if (start > lastIndex) {
      nodes.push(
        <Fragment key={`st-${i}`}>
          {renderInline(content.slice(lastIndex, start), candidates, onMentionClick)}
        </Fragment>,
      )
    }
    nodes.push(
      <StickerImage
        key={`s-${i}`}
        id={Number(match[1])}
        size={STICKER_SIZE}
        // Наведение на сам стикер, а не на строку сообщения: стикер занимает
        // её почти целиком, зато отдельного состояния «навели на сообщение»
        // для этого не нужно — а оно перерисовывало бы строку на каждое
        // движение мыши по ленте.
        play="hover"
        autoPlay={stickerAutoPlay}
      />,
    )
    lastIndex = start + match[0].length
  })
  if (lastIndex < content.length) {
    nodes.push(
      <Fragment key="st-last">
        {renderInline(content.slice(lastIndex), candidates, onMentionClick)}
      </Fragment>,
    )
  }
  return nodes
}

/** Сообщение в ленте. Неотправленные приходят сюда в той же форме, что и
 * настоящие (см. outbox.pendingAsMessage) — список не должен знать про два
 * разных типа, — но с отрицательным id и статусом доставки. */
export type ListMessage = ChatMessageBase & {
  pendingNonce?: string
  deliveryStatus?: DeliveryStatus
  /** Системная запись («X начинает ветку») — только у сообщений СЕРВЕРА (см.
   * api.Message). В личке/группе их не бывает вовсе, поэтому поля
   * необязательные: тот же список рисует и те, и другие. */
  system_kind?: MessageSystemKind
  system_thread?: { id: number; name: string; archived: boolean } | null
}

/** Русское склонение по числу: «1 сообщение», «2 сообщения», «5 сообщений».
 * Своё, а не Intl.PluralRules: правило тут одно и на три формы, а тащить ради
 * него локаль-зависимый API с его собственными названиями категорий («one»,
 * «few», «many») — больше кода, чем самого правила. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  const mod10 = n % 10
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/** Насколько давно написано — «1 мин. назад» под плашкой ветки. Крупнее суток
 * переходим на дату: «43 дн. назад» человек всё равно переводит в календарь
 * сам. */
function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин. назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч. назад`
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** Время у самого сообщения — сегодня достаточно HH:MM (день и так ясен из
 * контекста), вчера — с явной пометкой, раньше — с полной датой: чем
 * старше сообщение, тем меньше пользы от одного лишь времени без даты. */
function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (isSameDay(d, now)) return hm
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(d, yesterday)) return `Вчера, ${hm}`
  const dmy = d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  return `${dmy}, ${hm}`
}

/** Подпись разделителя между днями в ленте — см. .date-divider ниже. */
function formatDateSeparator(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/** Индикатор доставки — только на СВОИХ сообщениях. Иконки подобраны здесь,
 * а подписи и классы берутся из DELIVERY_STATUS_PRESENTATION (см. outbox.ts):
 * вид индикатора кастомизируется там, в одном месте. */
function DeliveryIndicator({ status }: { status: DeliveryStatus }) {
  const { label, className } = DELIVERY_STATUS_PRESENTATION[status]
  const icon =
    status === 'sending' ? (
      <Clock size={12} />
    ) : status === 'delivered' ? (
      <Check size={12} />
    ) : (
      <AlertCircle size={12} />
    )
  return (
    <span className={`msg-status ${className}`} title={label}>
      {icon}
    </span>
  )
}

export default function MessageList({
  messages,
  currentUserId,
  canModerate,
  editingId,
  onDelete,
  onEditRequest,
  onReply,
  onOpenProfile,
  onUserContextMenu,
  onToggleReaction,
  resolveUsername,
  mentionCandidates,
  onRetry,
  onDiscard,
  onAcceptServerInvite,
  onDeclineServerInvite,
  onOpenInvitedServer,
  onTogglePin,
  scrollAnchor,
  onReachedBottom,
  highlightMessageId,
  servers,
  conversations,
  threadOf,
  threadById,
  onOpenThread,
  onCreateThread,
  onThreadContextMenu,
  onShowAllThreads,
}: {
  messages: ListMessage[]
  currentUserId: number
  /** Владелец сервера — может удалять чужие сообщения (но не редактировать).
   * Для диалогов/групп всегда false — там нет модератора, см. ProfileModal/AppShell. */
  canModerate: boolean
  /** id сообщения, которое сейчас редактируется внизу в композере. */
  editingId: number | null
  onDelete: (messageId: number) => void
  onEditRequest: (message: ChatMessageBase) => void
  onReply: (message: ChatMessageBase) => void
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  /** Правый клик по отреагировавшему в «Показать реакции» (см.
   * MessageReactionsModal) — то же меню, что у строки друга (см.
   * FriendContextMenu), с человеком, кем бы он ни был. */
  onUserContextMenu: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  /** Поставить/снять реакцию. mine — стоит ли она уже от нас. */
  onToggleReaction: (messageId: number, emoji: string, mine: boolean) => void
  /** id участника → ник — для попапа со списком поставивших реакцию
   * (см. MessageReactions). Ростер сервера или участники диалога/группы. */
  resolveUsername: (userId: number) => string | undefined
  /** Ростер сервера или участники диалога/группы — для рендера "@Ник" в
   * тексте кликабельной кнопкой (см. renderMentions выше). Тот же набор,
   * что и mentionCandidates у MessageInput (автокомплит при наборе). */
  mentionCandidates: MentionCandidate[]
  /** Повторить отправку неотправленного сообщения (кнопка на «не доставлено»). */
  onRetry: (nonce: string) => void
  /** Выбросить неотправленное сообщение вместе с черновиком. */
  onDiscard: (nonce: string) => void
  /** Карточка приглашения на сервер (см. ChatMessageBase.server_invite) —
   * только у диалогов/групп, у серверных сообщений её не бывает. */
  onAcceptServerInvite?: (inviteId: number) => void
  onDeclineServerInvite?: (inviteId: number) => void
  onOpenInvitedServer?: (serverId: number) => void
  /** Закрепить/открепить сообщение канала. Не задан — фича недоступна:
   * так это выключено и в личке/группе (там закреплений нет вовсе), и у
   * тех, у кого нет права модерации сообщений (см. canModerate в AppShell). */
  onTogglePin?: (messageId: number, pinned: boolean) => void
  /** Куда встать прокрутке при следующем изменении `key` — на низ либо на
   * конкретное сообщение (id ищется через data-message-id ниже). Не задан —
   * список ведёт себя как раньше, чисто по эвристике «мы и так внизу» (см.
   * автопрокрутку ниже); задан — при смене key позиционируется явно, один раз.
   * Держит канал/диалог, для которого его посчитали (см. useChannelMessages
   * ScrollAnchor) — только код, который умеет считать «докуда дочитано»,
   * знает, когда именно этот расчёт готов. */
  scrollAnchor?: { key: string; target: 'bottom' | { messageId: number } } | null
  /** Лента фактически докручена до последнего сообщения — либо явной
   * прокруткой (кнопка «вниз»), либо автопрокруткой вслед за новым. Не задан —
   * фича недоступна (у диалогов/групп курсор прочтения не персистится, см.
   * AppShellChat). */
  onReachedBottom?: (messageId: number) => void
  /** Сообщение, к которому только что перепрыгнули из панели модератора, —
   * подсвечивается, пока не погаснет само (таймер живёт в
   * useChannelMessages). Без подсветки после скачка непонятно, ради какой
   * именно строки лента переехала. */
  highlightMessageId?: number | null
  /** Мои серверы (с каналами) и диалоги/группы — список получателей в
   * модалке «Переслать» (см. ForwardMessageModal). Тот же набор, что и в
   * AppShell целиком: список не завязан на то, что открыто СЕЙЧАС — можно
   * переслать в канал другого сервера, который прямо сейчас не выбран. */
  servers: Server[]
  conversations: Conversation[]
  /** Ветка, выросшая из этого сообщения, если она есть — под таким сообщением
   * рисуется плашка «Ветка: имя» (как в Discord). Не задан — веток здесь нет
   * вовсе (личка/группа). */
  threadOf?: (messageId: number) => Channel | undefined
  /** Ветка по её id — для системной записи «X начинает ветку»: её собственный
   * снимок ветки сделан в момент создания, а показывать надо текущее имя. */
  threadById?: (threadId: number) => Channel | undefined
  /** Клик по плашке — открыть ветку. */
  onOpenThread?: (thread: Channel) => void
  /** «Создать ветку» в контекстном меню сообщения. Не задан — пункта нет:
   * в личке/группе веток не бывает, а внутри самой ветки её не завести
   * (см. backend ChannelThreads). */
  onCreateThread?: (message: ListMessage) => void
  /** Правый клик по плашке ветки — её контекстное меню (присоединиться,
   * закрыть, переименовать и т.д., см. ThreadContextMenu). */
  onThreadContextMenu?: (thread: Channel, e: ReactMouseEvent) => void
  /** «Показать все ветки» в системной записи о создании ветки. */
  onShowAllThreads?: () => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /** Единственная точка, через которую идёт ЛЮБОЙ способ поставить/снять
   * реакцию — быстрые кнопки в ховер-панели, «+»-пикер, пилюли под
   * сообщением, новое контекстное меню и его флайаут. Оборачивает
   * onToggleReaction ради одного: учёта «часто используемых» (см.
   * reactionFrequency.ts) — только при ДОБАВЛЕНИИ (!mine), не при снятии,
   * иначе статистика росла бы и от того, что человек передумал. */
  const handleReact = (messageId: number, emoji: string, mine: boolean) => {
    if (!mine) recordReactionUse(emoji)
    onToggleReaction(messageId, emoji, mine)
  }

  // Какому сообщению сейчас выбирают реакцию: id + якорь для пикера.
  const [reactionPicker, setReactionPicker] = useState<{
    messageId: number
    anchor: EmojiPickerAnchor
  } | null>(null)
  /** Выбрали реакцию в пикере — общее для стандартных и кастомных: к этому
   * моменту и те, и другие уже сведены к одному ключу (см. emoji.ts).
   *
   * Панель НЕ закрывается здесь (см. EmojiPicker) — можно поставить подряд
   * несколько реакций на одно сообщение, не открывая пикер заново на каждую;
   * закроется она сама, когда курсор мыши её покинет. */
  const pickReaction = (emoji: string) => {
    if (!reactionPicker) return
    const message = messages.find((m) => m.id === reactionPicker.messageId)
    const mine = !!message?.reactions.some(
      (r) => r.emoji === emoji && r.user_ids.includes(currentUserId),
    )
    handleReact(reactionPicker.messageId, emoji, mine)
  }

  // Правый клик по сообщению — контекстное меню (см. MessageContextMenu).
  // «Показать реакции»/«Переслать» открывают СВОИ модалки уже после того, как
  // это меню закрылось (messageId, а не всё сообщение целиком — к моменту
  // открытия модалки нужна АКТУАЛЬНАЯ версия сообщения из messages, а не
  // снимок на момент правого клика: реакции могли обновиться, пока модалка
  // ещё не открылась).
  const [contextMenu, setContextMenu] = useContextMenuState<{
    message: ListMessage
    x: number
    y: number
  }>()
  const [reactionsModalId, setReactionsModalId] = useState<number | null>(null)
  const [forwardMessageId, setForwardMessageId] = useState<number | null>(null)
  const reactionsModalMessage = messages.find((m) => m.id === reactionsModalId) ?? null
  const forwardMessage = messages.find((m) => m.id === forwardMessageId) ?? null
  // Панель действий (реакции/ответ/редактировать/удалить) на десктопе
  // видна по :hover — на тач-устройстве такого нет вообще, а показывать её
  // сразу под КАЖДЫМ сообщением слишком шумно. Двойной тап по конкретному
  // сообщению открывает панель только для него; повторный двойной тап —
  // либо по нему же, либо по другому — закрывает/переключает.
  const [mobileActiveKey, setMobileActiveKey] = useState<string | number | null>(null)
  // Строка сообщения, на аватарке или нике которой сейчас курсор — только у
  // неё проигрывается гифка-аватар (см. Avatar.playAnimation). Ключ строки, а
  // не id автора: анимировать разом все сообщения одного человека в ленте —
  // ровно то мельтешение, ради отсутствия которого гифка по умолчанию стоит
  // статичным кадром.
  const [hoveredAuthorRow, setHoveredAuthorRow] = useState<string | number | null>(null)

  /** id последнего НАСТОЯЩЕГО сообщения в ленте — курсор прочтения (см.
   * onReachedBottom) может указывать только на то, что реально есть в БД, а
   * не на только что отправленное и ещё не подтверждённое (отрицательный id,
   * см. ListMessage). Неподтверждённые лежат в хвосте массива (дописывает
   * AppShellChat), поэтому достаточно поискать с конца. */
  const lastRealMessageId = useCallback((): number | null => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (!messages[i].pendingNonce) return messages[i].id
    }
    return null
  }, [messages])

  // Промотана ли лента дальше OTHERS_BOTTOM_PX от низа — только этим
  // управляется видимость круглой кнопки «вниз» (см. JSX). wasAtBottomRef
  // хранит то же самое булевым флагом в ref: эффекту ниже и обработчику
  // скролла нужно не текущее значение, а именно ПЕРЕХОД false → true, чтобы
  // не слать отметку «прочитано» на каждый пиксель скролла, а только один
  // раз — в момент, когда низ действительно достигнут.
  const [pastBottom, setPastBottom] = useState(false)
  const wasAtBottomRef = useRef(true)

  /** Достигли низа (программно или руками) — синхронизирует pastBottom,
   * гасит кнопку и, если это НОВОЕ достижение (не были там мгновение назад),
   * продвигает курсор прочтения. Общая точка для всех путей «мы внизу»:
   * автопрокрутки за новым сообщением, ручного скролла и клика по кнопке. */
  const notifyAtBottom = useCallback(
    (fresh: boolean) => {
      setPastBottom(false)
      if (fresh && !wasAtBottomRef.current) {
        const id = lastRealMessageId()
        if (id != null) onReachedBottom?.(id)
      }
      wasAtBottomRef.current = true
    },
    [lastRealMessageId, onReachedBottom],
  )

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom < OTHERS_BOTTOM_PX
    if (atBottom) {
      notifyAtBottom(true)
    } else {
      setPastBottom(true)
      wasAtBottomRef.current = false
    }
  }, [notifyAtBottom])

  // Автопрокрутка вниз. Раньше список прыгал к последнему сообщению
  // безусловно, и читать историю во время живой переписки было невозможно:
  // каждое чужое сообщение утаскивало вниз. Поэтому правил два, и они разные:
  //
  //   * ЧУЖОЕ сообщение утаскивает вниз, только если мы и так стояли у низа
  //     (в пределах OTHERS_BOTTOM_PX) — то есть читали живую переписку, а не
  //     листали историю;
  //   * СВОЁ — если лента промотана вверх меньше чем на MINE_SCROLLED_UP_MAX
  //     от всей высоты прокрутки. Порог здесь мягче осознанно: отправляя
  //     сообщение, человек хочет его увидеть, и «отправил, а оно улетело
  //     куда-то вверх» — это ровно то, чего он не ждёт. Но если он ушёл
  //     читать историю по-настоящему далеко, дёргать его не надо и тут:
  //     сообщение никуда не денется.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < OTHERS_BOTTOM_PX) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      notifyAtBottom(true)
      return
    }
    const last = messages[messages.length - 1]
    if (!last || last.author.id !== currentUserId) return
    // Доля прокрутки, а не пиксели: «на 30% вверх» в ленте на два экрана и в
    // ленте на сорок — совершенно разные расстояния, и постоянный порог в
    // одной из них означал бы «никогда».
    const scrollable = el.scrollHeight - el.clientHeight
    if (scrollable <= 0) return
    if (distanceFromBottom / scrollable <= MINE_SCROLLED_UP_MAX) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      notifyAtBottom(true)
    }
  }, [messages, currentUserId, notifyAtBottom])

  // Прокрутка сразу после открытия канала/диалога — на низ или на конкретное
  // сообщение (см. ScrollAnchor у useChannelMessages). appliedAnchorKeyRef не
  // даёт сработать повторно на КАЖДОЕ следующее изменение messages (эффект
  // всё равно перезапускается: живое сообщение меняет ссылку на массив) —
  // позиционирование одноразовое, ровно на смену anchor.key.
  //
  // useLayoutEffect, а не useEffect: скачок к произвольному сообщению должен
  // произойти ДО того, как браузer покажет кадр — иначе на миг мелькнёт низ
  // ленты, а потом дёрнется наверх, к настоящей цели.
  const appliedAnchorKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!scrollAnchor || appliedAnchorKeyRef.current === scrollAnchor.key) return
    appliedAnchorKeyRef.current = scrollAnchor.key
    if (scrollAnchor.target === 'bottom') {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    } else {
      const el = listRef.current
      const target = el?.querySelector<HTMLElement>(
        `[data-message-id="${scrollAnchor.target.messageId}"]`,
      )
      // Сообщение почему-то не нашлось (удалили ровно то, докуда дочитали, и
      // при этом не осталось контекста рядом) — не зависать посреди пустоты.
      if (target) target.scrollIntoView({ block: 'center' })
      else bottomRef.current?.scrollIntoView({ block: 'end' })
    }
    handleScroll()
  }, [scrollAnchor, messages, handleScroll])

  // Сообщение, для которого открыт DeleteMessageModal (обычный клик по
  // корзине — см. requestDelete). Shift+клик минует его — requestDelete
  // сразу зовёт startPendingDelete.
  const [confirmingDelete, setConfirmingDelete] = useState<ChatMessageBase | null>(null)

  // Имена авторов подставляет displayNameOf — чистая функция, читающая стор
  // никнеймов напрямую (хук на каждое сообщение в цикле не позовёшь).
  // Подписка на версию стора перерисовывает ленту, когда никнейм поменяли.
  useNicknamesVersion()

  // id сообщений в 10-секундном окне отмены — таймеры реального удаления
  // лежат в ref (не в стейте: сам по себе таймер не должен вызывать
  // перерисовку), а Set в стейте — только чтобы отрисовать затемнение/
  // перечёркивание и полоску отмены под нужным сообщением.
  const pendingDeleteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<number>>(new Set())

  // Таймеры — не эффект с cleanup на размонтирование: если уйти с канала, где
  // только что нажали "Удалить", отмена (и настоящее удаление по её
  // истечении) должна довестись до конца в фоне, а не молча забыться вместе
  // с компонентом — как и "отменить отправку" в других почтовых клиентах.
  const startPendingDelete = useCallback(
    (messageId: number) => {
      setPendingDeleteIds((prev) => new Set(prev).add(messageId))
      const timer = setTimeout(() => {
        pendingDeleteTimers.current.delete(messageId)
        setPendingDeleteIds((prev) => {
          const next = new Set(prev)
          next.delete(messageId)
          return next
        })
        onDelete(messageId)
      }, PENDING_DELETE_MS)
      pendingDeleteTimers.current.set(messageId, timer)
    },
    [onDelete],
  )

  const cancelPendingDelete = useCallback((messageId: number) => {
    const timer = pendingDeleteTimers.current.get(messageId)
    if (timer) clearTimeout(timer)
    pendingDeleteTimers.current.delete(messageId)
    setPendingDeleteIds((prev) => {
      const next = new Set(prev)
      next.delete(messageId)
      return next
    })
  }, [])

  /** Клик по корзине — обычный открывает подтверждение, Shift+клик
   * (см. подсказку в самой модалке) минует его и сразу ставит сообщение в
   * 10-секундное окно отмены. */
  const requestDelete = (m: ChatMessageBase, shiftKey: boolean) => {
    if (shiftKey) {
      startPendingDelete(m.id)
      return
    }
    setConfirmingDelete(m)
  }

  return (
    <div className="message-list" ref={listRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div className="message-empty">Пока нет сообщений. Напиши первым!</div>
      )}
      {messages.map((m, i) => {
        const isAuthor = m.author.id === currentUserId
        const pending = m.pendingNonce != null
        const pendingDelete = pendingDeleteIds.has(m.id)
        // Разделитель дня — перед первым сообщением дня целиком (включая
        // самое первое сообщение в ленте, если она не пуста), не перед
        // каждым отдельным сообщением.
        const showDateDivider =
          i === 0 || !isSameDay(new Date(m.created_at), new Date(messages[i - 1].created_at))
        // Статус показываем только на СВОИХ сообщениях: чужое «доставлено»
        // ни о чём не говорит. У подтверждённого сообщения собственного
        // статуса уже нет — оно приехало с сервера обычным message_create,
        // а сам факт этого и означает «доставлено».
        const status: DeliveryStatus | null = m.deliveryStatus
          ? m.deliveryStatus
          : isAuthor
            ? 'delivered'
            : null
        const rowKey = m.pendingNonce ?? m.id
        // Системная запись — своя строка: ни аватарки, ни ховер-действий, ни
        // реакций. Это не чьё-то высказывание, а отметка о событии в канале,
        // и вести себя как сообщение она не должна (см. Message.system_kind).
        if (m.system_kind === 'thread_created') {
          return (
            <Fragment key={rowKey}>
              {showDateDivider && (
                <div className="date-divider">
                  <span className="date-divider-line" />
                  <span className="date-divider-label">
                    {formatDateSeparator(m.created_at)}
                  </span>
                  <span className="date-divider-line" />
                </div>
              )}
              <div className="message-system-row" data-message-id={m.id}>
                <span className="message-system-icon">
                  <MessagesSquare size={15} />
                </span>
                <span className="message-system-text">
                  <span className="message-system-author">
                    {displayNameOf(m.author)}
                  </span>{' '}
                  начинает ветку:{' '}
                  {(() => {
                    if (!m.system_thread) return null
                    // Ветку берём из общего списка каналов: там она свежая
                    // (могли переименовать или закрыть), а снимок внутри самой
                    // записи сделан в момент создания и с тех пор не менялся.
                    // Не нашлась — значит доступа к ней у нас нет (приватная,
                    // куда не звали): показываем название без ссылки.
                    const live = threadById?.(m.system_thread.id)
                    if (!live || !onOpenThread) {
                      return (
                        <span className="message-system-thread-name">
                          {m.system_thread.name}
                        </span>
                      )
                    }
                    return (
                      <button
                        type="button"
                        className="message-system-link"
                        onClick={() => onOpenThread(live)}
                        onContextMenu={
                          onThreadContextMenu
                            ? (e) => {
                                e.preventDefault()
                                onThreadContextMenu(live, e)
                              }
                            : undefined
                        }
                      >
                        {live.name}
                      </button>
                    )
                  })()}
                  {'. '}
                  {onShowAllThreads && (
                    <button
                      type="button"
                      className="message-system-link"
                      onClick={onShowAllThreads}
                    >
                      Показать все ветки
                    </button>
                  )}
                </span>
                <span className="message-system-time">{formatTime(m.created_at)}</span>
              </div>
            </Fragment>
          )
        }
        return (
          <Fragment key={rowKey}>
            {showDateDivider && (
              <div className="date-divider">
                <span className="date-divider-line" />
                <span className="date-divider-label">{formatDateSeparator(m.created_at)}</span>
                <span className="date-divider-line" />
              </div>
            )}
          <div
            className={`message-row ${editingId === m.id ? 'editing' : ''} ${
              pending ? 'message-pending' : ''
            } ${m.deliveryStatus === 'failed' ? 'message-failed' : ''} ${
              mobileActiveKey === rowKey ? 'mobile-actions-active' : ''
            } ${highlightMessageId === m.id ? 'message-highlighted' : ''}`}
            // Точка входа для scrollAnchor (см. useLayoutEffect выше) — у
            // неподтверждённых (pending, отрицательный id) атрибут тоже
            // проставлен, просто querySelector по такому id никогда не ищут:
            // курсор прочтения ссылается только на настоящие id из БД.
            data-message-id={m.id}
            onDoubleClick={() => setMobileActiveKey((prev) => (prev === rowKey ? null : rowKey))}
            onContextMenu={(e) => {
              // Неотправленное/в окне отмены — действовать через контекстное
              // меню (ответить, переслать, реакция) не над чем: у него ещё
              // нет настоящего id, либо оно вот-вот исчезнет само.
              if (pending || pendingDelete) return
              // Аватарка и ник — не часть «сообщения» с точки зрения правого
              // клика: там свой смысл (профиль автора), и наше меню не должно
              // перехватывать клик, который метил именно туда. Отдаём его как
              // есть — сработает обычное контекстное меню браузера (скопировать
              // картинку и т.п.), а не гасим клик вовсе.
              if ((e.target as HTMLElement).closest('.avatar-trigger, .message-author')) {
                return
              }
              e.preventDefault()
              setContextMenu({ message: m, x: e.clientX, y: e.clientY })
            }}
          >
            <button
              type="button"
              className="avatar-trigger"
              onClick={(e) => onOpenProfile(m.author, e)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onUserContextMenu(m.author, e)
              }}
              onMouseEnter={() => setHoveredAuthorRow(rowKey)}
              onMouseLeave={() => setHoveredAuthorRow((prev) => (prev === rowKey ? null : prev))}
            >
              <Avatar
                name={m.author.username}
                color={m.author.avatar_color}
                image={m.author.avatar_image}
                size={40}
                userId={m.author.id}
                animated={m.author.avatar_animated}
                // В текстовых каналах гифка играет только под курсором — и
                // только у ЭТОГО сообщения, а не у всех сообщений автора
                // сразу (см. hoveredAuthorRow).
                playAnimation={hoveredAuthorRow === rowKey}
              />
            </button>
            <div className="message-body">
              {m.reply_to && (
                <div className="message-reply-quote">
                  <span className="message-reply-author">{displayNameOf(m.reply_to.author)}</span>
                  <span className="message-reply-content">
                    {/* Без кандидатов на упоминание: в цитате одной строкой
                        кликабельный «@ник» ни к чему, а вот токен эмодзи там
                        показался бы сырым «<:кот:1>». Стикер в цитате — просто
                        слово «стикер»: картинка в 160 пикселей разорвала бы
                        строку, ради которой цитата и существует. */}
                    {renderInline(
                      m.reply_to.content.replace(STICKER_TOKEN_RE, '[стикер]'),
                      [], onOpenProfile,
                    )}
                  </span>
                </div>
              )}
              <div className="message-meta">
                <span
                  className={`message-author profile-trigger-name ${styledNameProps(m.author).className}`}
                  style={styledNameProps(m.author).style}
                  onClick={(e) => onOpenProfile(m.author, e)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onUserContextMenu(m.author, e)
                  }}
                  // Ник — вторая точка наведения для гифки-аватара, наравне
                  // с самой аватаркой.
                  onMouseEnter={() => setHoveredAuthorRow(rowKey)}
                  onMouseLeave={() => setHoveredAuthorRow((prev) => (prev === rowKey ? null : prev))}
                >
                  {/* Мой никнейм для автора, если он есть (см. nicknames.ts).
                      Подписи с настоящим ником тут намеренно нет — в ленте
                      она повторялась бы у каждого сообщения; её место в
                      карточке и в списке друзей, где имя одно на человека. */}
                  {displayNameOf(m.author)}
                </span>
                <span className="message-time">{formatTime(m.created_at)}</span>
                {m.edited_at && <span className="message-edited">(изменено)</span>}
                {m.pinned && (
                  <span className="message-pinned-mark" title="Закреплено в канале">
                    <Pin size={11} /> закреплено
                  </span>
                )}
                {status && <DeliveryIndicator status={status} />}
              </div>
              {m.content && (
                <div className={`message-content ${pendingDelete ? 'message-content-deleting' : ''}`}>
                  {renderContent(
                    m.content, mentionCandidates, onOpenProfile, isFreshMessage(m.created_at),
                  )}
                </div>
              )}
              <MessageAttachments attachments={m.attachments} />
              {/* Плашка «Ветка: имя» — вход в выросшее из этого сообщения
                  обсуждение (см. Channel.source_message). Показывается и у
                  закрытой ветки: закрытие убирает её из сайдбара, но не
                  отсюда — иначе обсуждение стало бы недостижимым. */}
              {(() => {
                const thread = threadOf?.(m.id)
                if (!thread || !onOpenThread) return null
                const preview = thread.last_message
                return (
                  <div
                    className={`message-thread-chip ${thread.archived ? 'archived' : ''}`}
                    onContextMenu={
                      onThreadContextMenu
                        ? (e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            onThreadContextMenu(thread, e)
                          }
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="message-thread-chip-head"
                      onClick={() => onOpenThread(thread)}
                      title={
                        thread.archived
                          ? 'Ветка закрыта — открыть и почитать'
                          : 'Перейти в ветку'
                      }
                    >
                      <span className="message-thread-chip-name">{thread.name}</span>
                      <span className="message-thread-chip-count">
                        {thread.message_count}{' '}
                        {plural(thread.message_count, 'сообщение', 'сообщения', 'сообщений')}
                      </span>
                      <ChevronRight size={13} />
                      {thread.archived && (
                        <span className="message-thread-chip-tag">закрыта</span>
                      )}
                    </button>
                    {/* Последнее сообщение ветки — чтобы понимать, стоит ли
                        туда заходить, не заходя туда. Пустая ветка строки не
                        получает вовсе: показывать было бы нечего. */}
                    {preview && (
                      <button
                        type="button"
                        className="message-thread-chip-preview"
                        onClick={() => onOpenThread(thread)}
                      >
                        <Avatar
                          name={preview.author.username}
                          color={preview.author.avatar_color}
                          image={preview.author.avatar_image}
                          size={16}
                          userId={preview.author.id}
                        />
                        <span className="message-thread-chip-author">
                          {displayNameOf(preview.author)}
                        </span>
                        <span className="message-thread-chip-text">
                          {preview.content.replace(STICKER_TOKEN_RE, '[стикер]')
                            || 'вложение'}
                        </span>
                        <span className="message-thread-chip-time">
                          {formatRelative(preview.created_at)}
                        </span>
                      </button>
                    )}
                  </div>
                )
              })()}
              {m.server_invite && (
                <ServerInviteCard
                  invite={m.server_invite}
                  isAuthor={isAuthor}
                  onAccept={() => onAcceptServerInvite?.(m.server_invite!.id)}
                  onDecline={() => onDeclineServerInvite?.(m.server_invite!.id)}
                  onOpen={() => onOpenInvitedServer?.(m.server_invite!.server.id)}
                />
              )}
              {pendingDelete ? (
                <div className="message-delete-pending-bar">
                  <span className="message-delete-pending-text">Сообщение будет удалено…</span>
                  <button
                    type="button"
                    className="message-delete-undo"
                    onClick={() => cancelPendingDelete(m.id)}
                  >
                    Отменить
                  </button>
                </div>
              ) : (
                !pending && (
                  <MessageReactions
                    reactions={m.reactions}
                    currentUserId={currentUserId}
                    resolveUsername={resolveUsername}
                    onToggle={(emoji, mine) => handleReact(m.id, emoji, mine)}
                    onOpenPicker={(rect) =>
                      setReactionPicker({ messageId: m.id, anchor: { rect } })
                    }
                  />
                )
              )}
              {m.deliveryStatus === 'failed' && (
                <div className="message-failed-actions">
                  <span className="message-failed-text">
                    Не доставлено — сохранено в черновики.
                  </span>
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => onRetry(m.pendingNonce!)}
                  >
                    <RotateCw size={13} /> Повторить
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-small-danger"
                    onClick={() => onDiscard(m.pendingNonce!)}
                  >
                    Удалить
                  </button>
                </div>
              )}
            </div>
            {/* У неотправленного сообщения ещё нет id на сервере — отвечать,
                реагировать и удалять его через обычные ручки нельзя; для
                него свои кнопки выше. Сообщение в 10-секундном окне отмены —
                та же логика: действовать больше не над чем, кроме "Отменить"
                у самого текста. */}
            {!pending && !pendingDelete && (
              <div className="message-actions">
                {/* Быстрые реакции прямо в ховер-меню: самый частый сценарий —
                    поставить 👍, ради него открывать пикер незачем. */}
                {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
                  <button
                    key={emoji}
                    className="message-action message-action-emoji"
                    title={`Реакция ${emoji}`}
                    onClick={() =>
                      handleReact(
                        m.id,
                        emoji,
                        m.reactions.some(
                          (r) => r.emoji === emoji && r.user_ids.includes(currentUserId),
                        ),
                      )
                    }
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  className="message-action"
                  title="Добавить реакцию"
                  onClick={(e) =>
                    setReactionPicker({
                      messageId: m.id,
                      anchor: { rect: e.currentTarget.getBoundingClientRect() },
                    })
                  }
                >
                  <SmilePlus size={15} />
                </button>
                <button
                  className="message-action"
                  title="Ответить"
                  onClick={() => onReply(m)}
                >
                  <Reply size={15} />
                </button>
                {isAuthor && (
                  <button
                    className="message-action"
                    title="Изменить"
                    onClick={() => onEditRequest(m)}
                  >
                    <Pencil size={15} />
                  </button>
                )}
                {onTogglePin && (
                  <button
                    className="message-action"
                    title={m.pinned ? 'Открепить' : 'Закрепить сообщение'}
                    onClick={() => onTogglePin(m.id, !m.pinned)}
                  >
                    {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                  </button>
                )}
                {(isAuthor || canModerate) && (
                  <button
                    className="message-action message-action-danger"
                    title="Удалить (Shift+клик — без подтверждения)"
                    onClick={(e) => requestDelete(m, e.shiftKey)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            )}
          </div>
          </Fragment>
        )
      })}
      {/* Круглая кнопка «вниз» — sticky-элемент нулевой высоты в самом конце
          ленты (см. .jump-to-bottom-wrap): не занимает места в потоке (не
          сбивает scrollHeight, которым считается distanceFromBottom выше), а
          пока лента промотана дальше своей естественной позиции внизу —
          липнет к нижнему краю видимой области. Видна только когда есть
          смысл — pastBottom, а не всегда: кнопка «вернуться» на месте, где ты
          и так стоишь, только шумит. */}
      {pastBottom && (
        <div className="jump-to-bottom-wrap">
          <button
            type="button"
            className="jump-to-bottom-btn"
            title="Прокрутить вниз"
            onClick={() => {
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
              notifyAtBottom(true)
            }}
          >
            <ChevronDown size={20} />
          </button>
        </div>
      )}
      <div ref={bottomRef} />

      {reactionPicker && (
        <EmojiPicker
          anchor={reactionPicker.anchor}
          onPick={pickReaction}
          // Кастомный эмодзи едет в реакцию тем же ключом "custom:<id>", что
          // и на бэке (см. web/src/emoji.ts, backend chat/emoji.py) — дальше
          // по коду он ничем не отличается от unicode-символа.
          onPickCustom={(emoji) => pickReaction(customEmojiKey(emoji.id))}
          onClose={() => setReactionPicker(null)}
        />
      )}

      {confirmingDelete && (
        <DeleteMessageModal
          message={confirmingDelete}
          timeLabel={formatTime(confirmingDelete.created_at)}
          onClose={() => setConfirmingDelete(null)}
          onConfirm={() => {
            startPendingDelete(confirmingDelete.id)
            setConfirmingDelete(null)
          }}
        />
      )}

      {contextMenu && (
        <MessageContextMenu
          message={contextMenu.message}
          x={contextMenu.x}
          y={contextMenu.y}
          currentUserId={currentUserId}
          canPin={Boolean(onTogglePin)}
          onClose={() => setContextMenu(null)}
          onToggleReaction={(emoji, mine) => handleReact(contextMenu.message.id, emoji, mine)}
          onReply={() => onReply(contextMenu.message)}
          onTogglePin={
            onTogglePin
              ? () => onTogglePin(contextMenu.message.id, !contextMenu.message.pinned)
              : undefined
          }
          onRequestShowReactions={() => {
            setReactionsModalId(contextMenu.message.id)
            setContextMenu(null)
          }}
          onRequestForward={() => {
            setForwardMessageId(contextMenu.message.id)
            setContextMenu(null)
          }}
          // Ветка из этого сообщения уже есть — пункт ведёт в неё, а не
          // заводит вторую (и бэкенд второй не создаст, см. ChannelThreads).
          onCreateThread={
            onCreateThread ? () => onCreateThread(contextMenu.message) : undefined
          }
          hasThread={Boolean(threadOf?.(contextMenu.message.id))}
        />
      )}

      {reactionsModalMessage && (
        <MessageReactionsModal
          reactions={reactionsModalMessage.reactions}
          currentUserId={currentUserId}
          resolveUsername={resolveUsername}
          mentionCandidates={mentionCandidates}
          onOpenProfile={onOpenProfile}
          onUserContextMenu={onUserContextMenu}
          onClose={() => setReactionsModalId(null)}
        />
      )}

      {forwardMessage && (
        <ForwardMessageModal
          content={forwardMessage.content}
          attachments={forwardMessage.attachments}
          servers={servers}
          conversations={conversations}
          onForward={(targets, comment) => {
            for (const target of targets) {
              // Пустой content (чисто голосовое/файл) пересылать нечем —
              // вложения физически не переезжают (см. докстринг модалки),
              // а пустое сообщение backend всё равно отклонит.
              if (forwardMessage.content) {
                outbox.enqueue({ target, content: forwardMessage.content })
              }
              // Комментарий уезжает ВТОРЫМ, отдельным сообщением — так на
              // приёмной стороне видно и то, что переслали, и что к этому
              // добавили, а не одну слипшуюся реплику.
              if (comment) {
                outbox.enqueue({ target, content: comment })
              }
            }
          }}
          onClose={() => setForwardMessageId(null)}
        />
      )}
    </div>
  )
}
