import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EMOJI_CATEGORIES, EmojiEntry, searchEmoji } from '../emoji'

/**
 * Пикер эмодзи. Один на всё приложение: и для вставки в текст сообщения
 * (кнопка в композере), и для выбора реакции (кнопка «+» на сообщении) —
 * отличается только тем, что делает onPick.
 *
 * Позиционируется по «якорю» — прямоугольнику кнопки, которая его открыла
 * (getBoundingClientRect). Абсолютное позиционирование, а не выпадашка внутри
 * родителя: композер и строка реакций лежат в контейнерах с overflow, внутри
 * которых панель обрезалась бы.
 */

export interface EmojiPickerAnchor {
  /** Прямоугольник кнопки-открывашки в координатах вьюпорта. */
  rect: DOMRect
  /** Куда раскрывать относительно якоря. */
  placement?: 'above' | 'below'
}

const PANEL_WIDTH = 340
const PANEL_HEIGHT = 380
const VIEWPORT_MARGIN = 8

export default function EmojiPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: EmojiPickerAnchor
  onPick: (emoji: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState(EMOJI_CATEGORIES[0].id)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Закрытие по клику мимо и по Esc. mousedown, а не click: click по кнопке,
  // которая нас открыла, успел бы сработать повторно и открыть панель заново.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    // capture: иначе Esc сначала поймает модалка/композер снизу по дереву.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // useLayoutEffect, а не useEffect: позицию нужно поставить ДО того, как
  // браузер покажет кадр, иначе панель заметно прыгает из угла на место.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const { rect, placement = 'above' } = anchor
    let left = rect.left
    // Не вылезать за правый край экрана — прижимаемся к нему.
    left = Math.min(left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)
    left = Math.max(VIEWPORT_MARGIN, left)

    const above = rect.top - PANEL_HEIGHT - 6
    const below = rect.bottom + 6
    // Разворачиваемся в сторону, где есть место: у сообщения в самом верху
    // ленты «вверх» физически некуда.
    let top = placement === 'above' ? above : below
    if (top < VIEWPORT_MARGIN) top = below
    if (top + PANEL_HEIGHT > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, above)
    }
    setPosition({ left, top })
  }, [anchor])

  const results = useMemo(() => searchEmoji(query), [query])
  const isSearching = query.trim().length > 0

  const scrollToCategory = (id: string) => {
    setActiveCategory(id)
    const container = scrollRef.current
    const target = container?.querySelector<HTMLElement>(`[data-category="${id}"]`)
    if (container && target) {
      container.scrollTop = target.offsetTop - container.offsetTop
    }
  }

  const renderButton = (entry: EmojiEntry) => (
    <button
      key={entry.char}
      type="button"
      className="emoji-cell"
      title={entry.keywords[0]}
      onClick={() => onPick(entry.char)}
    >
      {entry.char}
    </button>
  )

  return (
    <div
      ref={panelRef}
      className="emoji-picker"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      }}
      // Панель живёт поверх сообщения: без этого клик по ней всплывал бы до
      // обработчиков строки сообщения (открытие профиля и т.п.).
      onClick={(e) => e.stopPropagation()}
    >
      <div className="emoji-picker-search">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск эмодзи"
        />
      </div>

      {!isSearching && (
        <div className="emoji-picker-tabs">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`emoji-tab ${activeCategory === c.id ? 'active' : ''}`}
              title={c.label}
              onClick={() => scrollToCategory(c.id)}
            >
              {c.icon}
            </button>
          ))}
        </div>
      )}

      <div className="emoji-picker-scroll" ref={scrollRef}>
        {isSearching ? (
          results.length === 0 ? (
            <div className="emoji-empty">Ничего не нашлось</div>
          ) : (
            <div className="emoji-grid">{results.map(renderButton)}</div>
          )
        ) : (
          EMOJI_CATEGORIES.map((category) => (
            <div key={category.id} data-category={category.id}>
              <div className="emoji-category-label">{category.label}</div>
              <div className="emoji-grid">{category.emoji.map(renderButton)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
