import { RefObject, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronRight, Copy, Forward, MessagesSquare, Pin, PinOff, Reply, SmilePlus, Users,
} from 'lucide-react'
import { CustomEmoji } from '../api'
import { customEmojiKey, STICKER_TOKEN_RE } from '../emoji'
import { frequentReactions } from '../reactionFrequency'
import { ListMessage } from './MessageList'
import { EmojiGlyph } from './MessageReactions'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'

/** Сколько реакций показывать в самом верху меню — прямо по клику, без
 * дополнительного разворачивания. */
const TOP_REACTIONS = 4
/** Сколько во флайауте «Добавить реакцию» — заметно больше верхней строки,
 * но всё ещё умещается в один ряд без переноса. */
const FLYOUT_REACTIONS = 8

/** Текст сообщения без токенов стикеров — то, что реально имеет смысл
 * копировать в буфер. Сообщение из одного стикера даёт пустую строку, и
 * кнопка «Скопировать текст» для него не показывается вовсе (см. ниже). */
function copyableText(content: string): string {
  return content.replace(STICKER_TOKEN_RE, '').trim()
}

/**
 * Правый клик по сообщению — общее контекстное меню и для текстовых
 * каналов, и для личных/групповых диалогов (закрепление — единственный
 * пункт, которого во втором случае нет: см. onTogglePin).
 *
 * Устроено как ChannelContextMenu: то же позиционирование с прижатием к
 * краю экрана (useLayoutEffect + clamp) и то же закрытие по клику мимо/Esc.
 * Каждый пункт меню, в отличие от ховер-панели под сообщением (там можно
 * подряд поставить несколько реакций, не закрывая пикер), сам закрывает всё
 * меню после действия — это однократный выбор действия, а не рабочая панель.
 *
 * «Добавить реакцию» и «Показать реакции»/«Переслать» устроены по-разному:
 * первое — вложенный флайаут ВНУТРИ этого же меню (см. flyoutOpen), вторые —
 * открывают отдельные модалки уже ПОСЛЕ того, как это меню закрылось
 * (см. onRequestShowReactions/onRequestForward — их держит и открывает
 * MessageList, а не эта, ephemeral-на-каждый-правый-клик, панель).
 */
export default function MessageContextMenu({
  message,
  x,
  y,
  currentUserId,
  canPin,
  onClose,
  onToggleReaction,
  onReply,
  onTogglePin,
  onRequestShowReactions,
  onRequestForward,
  onCreateThread,
  hasThread,
}: {
  message: ListMessage
  x: number
  y: number
  currentUserId: number
  /** Закрепление доступно вовсе — канал сервера, и есть право на модерацию
   * сообщений. Не задан — пункта нет совсем (личка/группа, либо нет права). */
  canPin?: boolean
  onClose: () => void
  onToggleReaction: (emoji: string, mine: boolean) => void
  onReply: () => void
  onTogglePin?: () => void
  onRequestShowReactions: () => void
  onRequestForward: () => void
  /** Завести ветку из этого сообщения (либо открыть уже существующую — см.
   * hasThread). Не задан — веток здесь нет вовсе: личка, группа или сама
   * ветка (ветка в ветке не заводится, см. backend ChannelThreads). */
  onCreateThread?: () => void
  /** Ветка из этого сообщения уже есть — пункт ведёт в неё, а не создаёт
   * вторую (второй бэкенд и не создаст, но подпись должна об этом говорить). */
  hasThread?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const [fullPickerAnchor, setFullPickerAnchor] = useState<EmojiPickerAnchor | null>(null)
  const flyoutBtnRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height
    }
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [x, y])

  // Клик мимо и Esc закрывают ВСЁ меню разом, включая открытый флайаут —
  // тот не самостоятельный попап, а часть этого же меню. Пока открыт полный
  // пикер («показать больше») — событие ему не мешает: EmojiPicker слушает
  // клики мимо СЕБЯ отдельно и сам решает, когда закрыться, а клик по нему
  // самому (внутри) этот обработчик не тронет, ведь он не «мимо» panel'и
  // выбора реакции, но панель эмодзи всё равно выше него по дереву, что не
  // имеет значения: обработчик слушает клик по документу вообще.
  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (ref.current?.contains(e.target as Node)) return
      // Флайаут и полный пикер — отдельные DOM-узлы (портала нет, но рисуются
      // соседями этого меню, а не внутри него, см. ReactionFlyout ниже и
      // EmojiPicker). Клик внутри НИХ не должен закрывать это меню — иначе
      // mousedown срывал бы меню (а вместе с ним и флайаут/пикер из DOM) ещё
      // ДО того, как за ним придёт click с самим выбором, и реакция/«показать
      // больше» долетали бы до уже снесённой кнопки.
      const flyoutEl = document.querySelector('.message-ctx-flyout')
      if (flyoutEl?.contains(e.target as Node)) return
      const pickerEl = document.querySelector('.emoji-picker')
      if (pickerEl?.contains(e.target as Node)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const mineOf = (emoji: string): boolean =>
    message.reactions.some((r) => r.emoji === emoji && r.user_ids.includes(currentUserId))

  const addReaction = (emoji: string) => {
    onToggleReaction(emoji, mineOf(emoji))
    onClose()
  }

  const top = frequentReactions(TOP_REACTIONS)
  const flyoutList = frequentReactions(FLYOUT_REACTIONS)
  const text = copyableText(message.content)
  const canCopyText = text.length > 0

  return (
    <>
      <div ref={ref} className="profile-popup message-context-menu" style={{ left: x, top: y }}>
        <div className="message-ctx-quick-reactions">
          {top.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="message-ctx-quick-reaction"
              title={`Реакция ${emoji.startsWith('custom:') ? '' : emoji}`}
              onClick={() => addReaction(emoji)}
            >
              <EmojiGlyph emoji={emoji} playing={false} />
            </button>
          ))}
        </div>

        <div className="profile-popup-divider" />

        <div className="profile-popup-menu">
          <button
            ref={flyoutBtnRef}
            type="button"
            className={`profile-popup-item ${flyoutOpen ? 'active' : ''}`}
            onClick={() => setFlyoutOpen((v) => !v)}
          >
            <SmilePlus size={15} /> Добавить реакцию
            <ChevronRight size={14} className="message-ctx-chevron" />
          </button>
          <button type="button" className="profile-popup-item" onClick={onRequestShowReactions}>
            <Users size={15} /> Показать реакции
          </button>
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => {
              onReply()
              onClose()
            }}
          >
            <Reply size={15} /> Ответить
          </button>
          <button type="button" className="profile-popup-item" onClick={onRequestForward}>
            <Forward size={15} /> Переслать
          </button>
          {onCreateThread && (
            <button
              type="button"
              className="profile-popup-item"
              onClick={() => {
                onCreateThread()
                onClose()
              }}
            >
              <MessagesSquare size={15} />
              {hasThread ? 'Перейти в ветку' : 'Создать ветку'}
            </button>
          )}
          {canCopyText && (
            <button
              type="button"
              className="profile-popup-item"
              onClick={() => {
                void navigator.clipboard.writeText(text)
                onClose()
              }}
            >
              <Copy size={15} /> Скопировать текст
            </button>
          )}
          {canPin && onTogglePin && (
            <button
              type="button"
              className="profile-popup-item"
              onClick={() => {
                onTogglePin()
                onClose()
              }}
            >
              {message.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              {message.pinned ? 'Открепить сообщение' : 'Закрепить сообщение'}
            </button>
          )}
        </div>
      </div>

      {flyoutOpen && (
        <ReactionFlyout
          triggerRef={flyoutBtnRef}
          list={flyoutList}
          onPick={addReaction}
          onMore={(rect) => {
            setFullPickerAnchor({ rect, placement: 'below' })
            setFlyoutOpen(false)
          }}
        />
      )}

      {fullPickerAnchor && (
        <EmojiPicker
          anchor={fullPickerAnchor}
          onPick={addReaction}
          // Кастомный эмодзи едет в реакцию тем же ключом "custom:<id>", что
          // и на бэке (см. web/src/emoji.ts, backend chat/emoji.py).
          onPickCustom={(emoji: CustomEmoji) => addReaction(customEmojiKey(emoji.id))}
          // Стикер реакцией быть не может (onPickSticker не задан — вкладки
          // стикеров у этого инстанса пикера нет вовсе, см. EmojiPicker).
          onClose={() => {
            setFullPickerAnchor(null)
            onClose()
          }}
        />
      )}
    </>
  )
}

/** Флайаут «Добавить реакцию»: один ряд самых частых эмодзи плюс кнопка
 * «показать больше», раскрывающая полный пикер. Отдельный компонент — своя
 * позиция (справа от кнопки-триггера, с прижатием к краю экрана), которую
 * бессмысленно инлайнить в уже и так длинный MessageContextMenu. */
function ReactionFlyout({
  triggerRef,
  list,
  onPick,
  onMore,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>
  list: string[]
  onPick: (emoji: string) => void
  onMore: (rect: DOMRect) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const el = ref.current
    if (!trigger || !el) return
    const margin = 8
    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = el.getBoundingClientRect()
    // По умолчанию — справа от кнопки; не влезает — слева.
    let left = triggerRect.right + 4
    if (left + panelRect.width > window.innerWidth - margin) {
      left = triggerRect.left - panelRect.width - 4
    }
    let top = triggerRect.top
    if (top + panelRect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - panelRect.height
    }
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [triggerRef])

  return (
    <div ref={ref} className="profile-popup message-ctx-flyout">
      <div className="message-ctx-flyout-row">
        {list.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="message-ctx-quick-reaction"
            onClick={() => onPick(emoji)}
          >
            <EmojiGlyph emoji={emoji} playing={false} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="message-ctx-flyout-more"
        onClick={(e) => onMore(e.currentTarget.getBoundingClientRect())}
      >
        Показать больше 🙂
      </button>
    </div>
  )
}
