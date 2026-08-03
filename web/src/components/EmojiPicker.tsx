import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { CustomEmoji, api } from '../api'
import { customEmojiStore, useCustomEmojiPacks, useEmojiUploadTargets } from '../customEmoji'
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
 *
 * Выбор эмодзи панель НЕ закрывает — можно поставить подряд несколько
 * (несколько реакций, несколько эмодзи в сообщение). Закрывается она, когда
 * курсор мыши покидает её пределы (см. onMouseLeave), а также по Esc или
 * клику мимо, как раньше.
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
  /** Панель НЕ закрывает себя сама после выбора — вызывающий
   * (onPick/onPickCustom) вставляет эмодзи и на этом всё: если бы каждый клик
   * заново закрывал панель, поставить подряд несколько эмодзи (или реакций)
   * значило бы открывать её заново после каждого. Закрывается панель либо
   * этим onClose (мышь ушла с неё, см. onMouseLeave ниже), либо по Esc/клику
   * мимо (см. эффект ниже). */
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState(EMOJI_CATEGORIES[0].id)
  const [editorOpen, setEditorOpen] = useState(false)
  // Правый клик по своему эмодзи — маленькое меню «Удалить» рядом с
  // курсором. Своё состояние, а не переиспользование editorOpen: закрывается
  // по-другому (см. эффект ниже и onClick панели) и не должно блокировать
  // остальную панель так же, как редактор.
  const [emojiMenu, setEmojiMenu] = useState<{ emoji: CustomEmoji; x: number; y: number } | null>(
    null,
  )
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
        // Сначала закрываем маленькое меню «Удалить», если оно открыто —
        // второй Esc закроет уже саму панель.
        if (emojiMenu) {
          setEmojiMenu(null)
          return
        }
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
  }, [onClose, editorOpen, emojiMenu])

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

  /** Могу ли я удалить/переименовать этот конкретный эмодзи — право
   * «Управление выражениями» на сервере, которому он принадлежит. Ищем по
   * emoji.server, а не по активной вкладке: в поиске (customResults) эмодзи
   * с разных серверов лежат в одной сетке вперемешку. */
  const canManageEmoji = (emoji: CustomEmoji): boolean =>
    packs.find((p) => p.server.id === emoji.server)?.server.canManage ?? false

  const renderCustom = (emoji: CustomEmoji) => (
    <button
      key={emoji.id}
      type="button"
      className="emoji-cell emoji-cell-custom"
      title={`:${emoji.name}:`}
      onClick={() => onPickCustom?.(emoji)}
      onContextMenu={(e) => {
        if (!canManageEmoji(emoji)) return
        e.preventDefault()
        // Прижимаем к правому/нижнему краю панели — меню маленькое (одна
        // строка), большого запаса можно не считать через layout-эффект, как
        // у больших контекстных меню (ParticipantContextMenu и т.п.).
        const x = Math.min(e.clientX, window.innerWidth - 180)
        const y = Math.min(e.clientY, window.innerHeight - 90)
        setEmojiMenu({ emoji, x, y })
      }}
    >
      {/* play="hover" — в сетке анимация запускается наведением: это ровно
          тот момент, когда на эмодзи смотрят и выбирают. */}
      <CustomEmojiImage id={emoji.id} emoji={emoji} size={26} />
    </button>
  )

  /** Удалить эмодзи прямо из пикера — то же самое, что и вкладка «Эмодзи» в
   * настройках сервера (ServerSettingsModal), только без похода туда:
   * набор общий (customEmojiStore), обновление увидят все, кто открыл
   * настройки, и наоборот. */
  const handleDeleteEmoji = async (emoji: CustomEmoji) => {
    setEmojiMenu(null)
    if (!window.confirm(`Удалить :${emoji.name}:? Он пропадёт из пикера у всех.`)) {
      return
    }
    try {
      await api.deleteEmoji(emoji.server, emoji.id)
      // Реестр обновится и событием server_emoji по WebSocket, но не ждём
      // его — тому, кто только что удалил, эмодзи должен исчезнуть из сетки
      // сразу, а не через сетевой круг туда-обратно.
      const remaining = (
        customEmojiStore.getPacks().find((p) => p.server.id === emoji.server)?.emoji ?? []
      ).filter((e) => e.id !== emoji.id)
      customEmojiStore.setServerEmoji(emoji.server, remaining)
    } catch (err) {
      alert((err as Error).message)
    }
  }

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
      // обработчиков строки сообщения (открытие профиля и т.п.). Заодно
      // гасит маленькое меню «Удалить» при клике куда угодно ещё внутри
      // панели — правый клик по другому эмодзи сам переставит его на новое
      // место, так что здесь актуально только «клик мимо, но внутри».
      onClick={(e) => {
        e.stopPropagation()
        setEmojiMenu(null)
      }}
      // Основной способ закрыться: панель не закрывается сама после выбора
      // (см. докстринг onClose выше) — вместо этого закрывается, когда
      // курсор мыши её покидает. Пока открыт редактор (поверх, вне DOM
      // панели) — событие игнорируем: движение мыши на редактор технически
      // «покидает» панель, но закрывать в этот момент нечего, редактор — её
      // же дочерний экран.
      onMouseLeave={() => {
        if (!editorOpen) onClose()
      }}
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

      {emojiMenu && (
        <div
          className="profile-popup emoji-context-menu"
          style={{ left: emojiMenu.x, top: emojiMenu.y }}
          // Иначе клик по «Удалить» долетел бы до onClick панели ВЫШЕ этого
          // элемента в дереве — не страшно (та лишь погасила бы уже погашенное
          // меню), но и не нужно.
          onClick={(e) => e.stopPropagation()}
        >
          <div className="profile-popup-label">:{emojiMenu.emoji.name}:</div>
          <div className="profile-popup-menu">
            <button
              type="button"
              className="profile-popup-item profile-popup-item-danger"
              onClick={() => void handleDeleteEmoji(emojiMenu.emoji)}
            >
              <Trash2 size={15} /> Удалить
            </button>
          </div>
        </div>
      )}

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
