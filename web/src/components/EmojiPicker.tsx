import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { CustomEmoji } from '../api'
import { useCustomEmojiPacks, useEmojiUploadTargets } from '../customEmoji'
import { EMOJI_CATEGORIES, EmojiEntry, searchEmoji } from '../emoji'
import CustomEmojiImage from './CustomEmojiImage'
import EmojiEditorModal from './EmojiEditorModal'
import EmojiTabStrip from './EmojiTabStrip'

/**
 * Пикер эмодзи. Один на всё приложение: и для вставки в текст сообщения
 * (кнопка в композере), и для выбора реакции (кнопка «+» на сообщении) —
 * отличается только тем, что делает onPick.
 *
 * Лента вкладок поделена пополам. Слева — стандартные категории, справа —
 * наборы кастомных эмодзи (набор = сервер, его значок и есть иконка вкладки),
 * плюс кнопка «+» для загрузки нового. Половины прокручиваются независимо
 * (см. EmojiTabStrip): своих серверов у человека бывает и двадцать, и лента,
 * растущая за счёт стандартных категорий, вытолкнула бы их за край.
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

const PANEL_WIDTH = 400
const PANEL_HEIGHT = 420
const VIEWPORT_MARGIN = 8

/** Префикс id секции кастомного набора — чтобы не столкнуться с id категорий
 * стандартных эмодзи (те строковые: 'smileys', 'food'…). */
const PACK_SECTION = 'pack:'

export default function EmojiPicker({
  anchor,
  onPick,
  onPickCustom,
  onClose,
}: {
  anchor: EmojiPickerAnchor
  /** Выбран стандартный эмодзи — приходит сам символ. */
  onPick: (emoji: string) => void
  /** Выбран кастомный. Не задан — половина с кастомными не показывается
   * вовсе: не везде, где нужен пикер, картинка вообще уместна (например, в
   * поле «эмодзи статуса» на бэкенде лежит строка, а не ссылка). */
  onPickCustom?: (emoji: CustomEmoji) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState(EMOJI_CATEGORIES[0].id)
  const [editorOpen, setEditorOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const allPacks = useCustomEmojiPacks()
  const uploadTargets = useEmojiUploadTargets()
  // useMemo, а не тернарник прямо тут: пустая ветка возвращала бы НОВЫЙ []
  // на каждый рендер, и поиск по кастомным (useMemo ниже) пересчитывался бы
  // на каждое нажатие клавиши в любом другом состоянии панели.
  const packs = useMemo(
    () => (onPickCustom ? allPacks : []),
    [onPickCustom, allPacks],
  )
  const canAdd = Boolean(onPickCustom && uploadTargets.length > 0)

  // Закрытие по клику мимо и по Esc. mousedown, а не click: click по кнопке,
  // которая нас открыла, успел бы сработать повторно и открыть панель заново.
  //
  // Пока открыт редактор — не закрываемся ни от того, ни от другого: он лежит
  // ПОВЕРХ панели и вне её DOM, так что любой клик в нём считался бы «мимо» и
  // сносил бы вместе с панелью сам редактор. Esc в это время закрывает
  // редактор (он в стеке модалок, см. useEscToClose).
  useEffect(() => {
    if (editorOpen) return
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
  }, [onClose, editorOpen])

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

  const isSearching = query.trim().length > 0
  const results = useMemo(() => searchEmoji(query), [query])
  // Кастомные ищутся по имени, и только по началу слова — тем же правилом,
  // что и стандартные (см. searchEmoji): по «кот» находится :котик:, но не
  // :бегемот:.
  const customResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return packs.flatMap((pack) =>
      pack.emoji.filter((emoji) => emoji.name.toLowerCase().startsWith(q)),
    )
  }, [query, packs])

  const scrollToSection = (id: string) => {
    setActiveSection(id)
    const container = scrollRef.current
    const target = container?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (container && target) {
      container.scrollTop = target.offsetTop - container.offsetTop
    }
  }

  const renderStandard = (entry: EmojiEntry) => (
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

  const renderCustom = (emoji: CustomEmoji) => (
    <button
      key={emoji.id}
      type="button"
      className="emoji-cell emoji-cell-custom"
      title={`:${emoji.name}:`}
      onClick={() => onPickCustom?.(emoji)}
    >
      {/* play="hover" — в сетке анимация запускается наведением: это ровно
          тот момент, когда на эмодзи смотрят и выбирают. */}
      <CustomEmojiImage id={emoji.id} emoji={emoji} size={26} />
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
          <EmojiTabStrip className="emoji-strip-standard">
            {EMOJI_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`emoji-tab ${activeSection === c.id ? 'active' : ''}`}
                title={c.label}
                onClick={() => scrollToSection(c.id)}
              >
                {c.icon}
              </button>
            ))}
          </EmojiTabStrip>

          {onPickCustom && <div className="emoji-tabs-divider" />}

          {onPickCustom && (
            <div className="emoji-tabs-custom">
              {canAdd && (
                <button
                  type="button"
                  className="emoji-tab emoji-tab-add"
                  title="Добавить свой эмодзи"
                  onClick={() => setEditorOpen(true)}
                >
                  <Plus size={16} />
                </button>
              )}
              <EmojiTabStrip>
                {packs.length === 0 ? (
                  <span className="emoji-tabs-hint">
                    {canAdd ? 'Свои эмодзи — сюда' : 'Своих эмодзи нет'}
                  </span>
                ) : (
                  packs.map((pack) => {
                    const id = `${PACK_SECTION}${pack.server.id}`
                    return (
                      <button
                        key={pack.server.id}
                        type="button"
                        className={`emoji-tab emoji-tab-pack ${
                          activeSection === id ? 'active' : ''
                        }`}
                        title={pack.server.name}
                        onClick={() => scrollToSection(id)}
                      >
                        {pack.server.icon ? (
                          <img src={pack.server.icon} alt="" draggable={false} />
                        ) : (
                          <span className="emoji-tab-initial">
                            {pack.server.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </button>
                    )
                  })
                )}
              </EmojiTabStrip>
            </div>
          )}
        </div>
      )}

      <div className="emoji-picker-scroll" ref={scrollRef}>
        {isSearching ? (
          results.length === 0 && customResults.length === 0 ? (
            <div className="emoji-empty">Ничего не нашлось</div>
          ) : (
            <>
              {customResults.length > 0 && (
                <div>
                  <div className="emoji-category-label">Свои эмодзи</div>
                  <div className="emoji-grid">{customResults.map(renderCustom)}</div>
                </div>
              )}
              {results.length > 0 && <div className="emoji-grid">{results.map(renderStandard)}</div>}
            </>
          )
        ) : (
          <>
            {/* Кастомные сверху: за ними идут сюда чаще, чем за стандартным
                смайлом — тот и так знаком наизусть. */}
            {packs.map((pack) => (
              <div key={pack.server.id} data-section={`${PACK_SECTION}${pack.server.id}`}>
                <div className="emoji-category-label">{pack.server.name}</div>
                <div className="emoji-grid">{pack.emoji.map(renderCustom)}</div>
              </div>
            ))}
            {EMOJI_CATEGORIES.map((category) => (
              <div key={category.id} data-section={category.id}>
                <div className="emoji-category-label">{category.label}</div>
                <div className="emoji-grid">{category.emoji.map(renderStandard)}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {editorOpen && (
        <EmojiEditorModal
          targets={uploadTargets}
          onClose={() => setEditorOpen(false)}
          // Только что загруженный эмодзи сразу подставляем туда, ради чего
          // пикер и открывали, — иначе после редактора пришлось бы искать его
          // в сетке руками.
          onCreated={(emoji) => onPickCustom?.(emoji)}
        />
      )}
    </div>
  )
}
