import {
  Fragment, ReactNode, useCallback, useEffect, useRef, useState,
  MouseEvent as ReactMouseEvent,
} from 'react'
import {
  AlertCircle, Check, Clock, Pin, PinOff, Reply, Pencil, RotateCw, SmilePlus, Trash2,
} from 'lucide-react'
import { ChatMessageBase, MentionCandidate } from '../api'
import { escapeRegExp, WORD_CHAR } from '../mentions'
import { styledNameProps } from '../nameStyle'
import { displayNameOf, useNicknamesVersion } from '../nicknames'
import { DeliveryStatus, DELIVERY_STATUS_PRESENTATION } from '../outbox'
import { QUICK_REACTIONS } from '../emoji'
import Avatar from './Avatar'
import DeleteMessageModal from './DeleteMessageModal'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'
import MessageAttachments from './MessageAttachments'
import MessageReactions from './MessageReactions'
import ServerInviteCard from './ServerInviteCard'
import { ProfilePopupUser } from './MiniProfilePopup'

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

/** Сообщение в ленте. Неотправленные приходят сюда в той же форме, что и
 * настоящие (см. outbox.pendingAsMessage) — список не должен знать про два
 * разных типа, — но с отрицательным id и статусом доставки. */
export type ListMessage = ChatMessageBase & {
  pendingNonce?: string
  deliveryStatus?: DeliveryStatus
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
  onToggleReaction,
  resolveUsername,
  mentionCandidates,
  onRetry,
  onDiscard,
  onAcceptServerInvite,
  onDeclineServerInvite,
  onOpenInvitedServer,
  onTogglePin,
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
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Какому сообщению сейчас выбирают реакцию: id + якорь для пикера.
  const [reactionPicker, setReactionPicker] = useState<{
    messageId: number
    anchor: EmojiPickerAnchor
  } | null>(null)
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

  // Автопрокрутка вниз — только если мы и так стояли внизу. Раньше список
  // прыгал к последнему сообщению безусловно, и читать историю во время
  // живой переписки было невозможно: каждое чужое сообщение утаскивало вниз.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 150) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

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
    <div className="message-list" ref={listRef}>
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
            }`}
            onDoubleClick={() => setMobileActiveKey((prev) => (prev === rowKey ? null : rowKey))}
          >
            <button
              type="button"
              className="avatar-trigger"
              onClick={(e) => onOpenProfile(m.author, e)}
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
                  <span className="message-reply-content">{m.reply_to.content}</span>
                </div>
              )}
              <div className="message-meta">
                <span
                  className={`message-author profile-trigger-name ${styledNameProps(m.author).className}`}
                  style={styledNameProps(m.author).style}
                  onClick={(e) => onOpenProfile(m.author, e)}
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
                  {renderMentions(m.content, mentionCandidates, onOpenProfile)}
                </div>
              )}
              <MessageAttachments attachments={m.attachments} />
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
                    onToggle={(emoji, mine) => onToggleReaction(m.id, emoji, mine)}
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
                      onToggleReaction(
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
      <div ref={bottomRef} />

      {reactionPicker && (
        <EmojiPicker
          anchor={reactionPicker.anchor}
          onPick={(emoji) => {
            const message = messages.find((m) => m.id === reactionPicker.messageId)
            const mine = !!message?.reactions.some(
              (r) => r.emoji === emoji && r.user_ids.includes(currentUserId),
            )
            onToggleReaction(reactionPicker.messageId, emoji, mine)
            setReactionPicker(null)
          }}
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
    </div>
  )
}
