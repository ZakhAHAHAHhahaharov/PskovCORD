import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { CustomEmoji, Sticker, StickerPack, api } from '../api'
import { customEmojiStore, useCustomEmojiPacks, useEmojiUploadTargets, useExpressionServers } from '../customEmoji'
import { EMOJI_CATEGORIES, EmojiEntry, searchEmoji } from '../emoji'
import { useDragScroll } from '../dragScroll'
import { stickerStore, useStickerPacks } from '../stickers'
import CustomEmojiImage from './CustomEmojiImage'
import EmojiEditorModal from './EmojiEditorModal'
import EmojiTabStrip from './EmojiTabStrip'
import StickerEditorModal from './StickerEditorModal'
import StickerImage from './StickerImage'

/**
 * Пикер выражений. Один на всё приложение: и для вставки в текст сообщения
 * (кнопки в композере), и для выбора реакции (кнопка «+» на сообщении) —
 * отличается только тем, что делает onPick.
 *
 * Две вкладки — стикеры и эмодзи, переключатель над строкой поиска. Панель
 * одна на оба, потому что и открывают её за одним и тем же: «отправить
 * картинку вместо слов». Кнопок в композере при этом две (стикер и смайл), и
 * каждая открывает эту же панель сразу на своей вкладке — см. mode.
 *
 * Лента вкладок внутри каждого режима поделена пополам. У эмодзи слева
 * стандартные категории, справа — наборы серверов; у стикеров слева базовые
 * наборы, справа — серверные. Половины прокручиваются независимо (см.
 * EmojiTabStrip): своих серверов у человека бывает и двадцать.
 *
 * Прокрутка везде работает перетаскиванием зажатой левой кнопкой (см.
 * dragScroll.ts) — и в лентах вкладок, и в самой сетке: без колеса мыши
 * пользоваться панелью иначе невозможно.
 *
 * Позиционируется по «якорю» — прямоугольнику кнопки, которая его открыла
 * (getBoundingClientRect). Абсолютное позиционирование, а не выпадашка внутри
 * родителя: композер и строка реакций лежат в контейнерах с overflow, внутри
 * которых панель обрезалась бы.
 *
 * Выбор эмодзи или стикера панель НЕ закрывает — можно отправить подряд
 * несколько. Закрывается она ТОЛЬКО левым кликом мимо (и по Esc): ни уход
 * мыши, ни правый клик её не гасят — иначе тянуть содержимое мышью, целясь в
 * стикер у самого края, значило бы постоянно терять панель на полпути.
 */

export interface EmojiPickerAnchor {
  /** Прямоугольник кнопки-открывашки в координатах вьюпорта. */
  rect: DOMRect
  /** Куда раскрывать относительно якоря. */
  placement?: 'above' | 'below'
}

/** Какая вкладка открыта. */
export type PickerMode = 'emoji' | 'stickers'

const PANEL_WIDTH = 400
const PANEL_HEIGHT = 440
const VIEWPORT_MARGIN = 8

/** Сторона стикера в сетке. Из неё же выводится число колонок (три в ряд —
 * см. .sticker-grid): стикер должен быть заметно крупнее эмодзи, иначе
 * выбирать его не по чему, отличаются они как раз рисунком. */
const STICKER_CELL = 104

/** Префикс id секции набора — чтобы не столкнуться с id категорий стандартных
 * эмодзи (те строковые: 'smileys', 'food'…). */
const PACK_SECTION = 'pack:'

export default function EmojiPicker({
  anchor,
  mode: initialMode = 'emoji',
  onPick,
  onPickCustom,
  onPickSticker,
  onClose,
}: {
  anchor: EmojiPickerAnchor
  /** Вкладка, на которой открыться. */
  mode?: PickerMode
  /** Выбран стандартный эмодзи — приходит сам символ. */
  onPick: (emoji: string) => void
  /** Выбран кастомный. Не задан — половина с кастомными не показывается
   * вовсе: не везде, где нужен пикер, картинка вообще уместна (например, в
   * поле «эмодзи статуса» на бэкенде лежит строка, а не ссылка). */
  onPickCustom?: (emoji: CustomEmoji) => void
  /** Выбран стикер. Не задан — вкладки стикеров нет: реакцией стикер быть не
   * может, да и в «эмодзи статуса» ему делать нечего. */
  onPickSticker?: (sticker: Sticker) => void
  /** Панель НЕ закрывает себя сама после выбора — вызывающий вставляет
   * эмодзи (или отправляет стикер) и на этом всё: если бы каждый клик заново
   * закрывал панель, поставить подряд несколько значило бы открывать её
   * заново после каждого. Закрывается панель левым кликом мимо или по Esc —
   * см. эффект ниже. */
  onClose: () => void
}) {
  const [mode, setMode] = useState<PickerMode>(
    onPickSticker ? initialMode : 'emoji',
  )
  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState<string>(EMOJI_CATEGORIES[0].id)
  const [editorOpen, setEditorOpen] = useState(false)
  const [stickerUploadOpen, setStickerUploadOpen] = useState(false)
  // Правый клик по своему эмодзи/стикеру — маленькое меню «Удалить» рядом с
  // курсором. Своё состояние, а не переиспользование editorOpen: закрывается
  // по-другому (см. эффект ниже и onClick панели) и не должно блокировать
  // остальную панель так же, как редактор.
  const [menu, setMenu] = useState<
    { emoji: CustomEmoji; sticker?: undefined; x: number; y: number }
    | { sticker: Sticker; emoji?: undefined; x: number; y: number }
    | null
  >(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Пока открыт любой из дочерних экранов (редактор эмодзи, загрузка стикера)
  // панель считается «занятой»: он лежит ПОВЕРХ неё и вне её DOM, так что
  // любой клик в нём был бы «мимо» и снёс бы вместе с панелью сам экран.
  const childOpen = editorOpen || stickerUploadOpen

  const allPacks = useCustomEmojiPacks()
  const uploadTargets = useEmojiUploadTargets()
  const servers = useExpressionServers()
  const allStickerPacks = useStickerPacks()
  // useMemo, а не тернарник прямо тут: пустая ветка возвращала бы НОВЫЙ []
  // на каждый рендер, и поиск (useMemo ниже) пересчитывался бы на каждое
  // нажатие клавиши в любом другом состоянии панели.
  const packs = useMemo(() => (onPickCustom ? allPacks : []), [onPickCustom, allPacks])
  const stickerPacks = useMemo(
    () => (onPickSticker ? allStickerPacks : []),
    [onPickSticker, allStickerPacks],
  )
  const canAdd = Boolean(onPickCustom && uploadTargets.length > 0)
  const canAddSticker = Boolean(onPickSticker && uploadTargets.length > 0)

  // Закрытие по клику мимо и по Esc. mousedown, а не click: click по кнопке,
  // которая нас открыла, успел бы сработать повторно и открыть панель заново.
  // Только ЛЕВАЯ кнопка: правый клик мимо открывает контекстное меню, и
  // сносить под ним панель незачем — а внутри панели правый клик и вовсе её
  // собственное меню «Удалить».
  useEffect(() => {
    if (childOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        // Сначала закрываем маленькое меню «Удалить», если оно открыто —
        // второй Esc закроет уже саму панель.
        if (menu) {
          setMenu(null)
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
  }, [onClose, childOpen, menu])

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

  // Перетаскивание сетки. Только по вертикали: горизонтали у неё нет, а «обе
  // оси» означало бы, что случайный боковой рывок съедает клик по стикеру.
  const gridDrag = useDragScroll(scrollRef, { axis: 'y' })

  const isSearching = query.trim().length > 0
  const results = useMemo(() => searchEmoji(query), [query])
  // Кастомные эмодзи ищутся по имени и только по началу слова — тем же
  // правилом, что и стандартные (см. searchEmoji): по «кот» находится :котик:,
  // но не :бегемот:.
  const customResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return packs.flatMap((pack) =>
      pack.emoji.filter((emoji) => emoji.name.toLowerCase().startsWith(q)),
    )
  }, [query, packs])
  // Стикеры — тем же правилом, но по любому слову в названии: имя у них
  // человеческое («кот в шляпе»), и искать по нему только с первой буквы
  // означало бы не находить ничего.
  const stickerResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return stickerPacks.flatMap((pack) =>
      pack.stickers.filter((sticker) =>
        sticker.name.toLowerCase().split(' ').some((word) => word.startsWith(q)),
      ),
    )
  }, [query, stickerPacks])

  const scrollToSection = (id: string) => {
    setActiveSection(id)
    const container = scrollRef.current
    const target = container?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (container && target) {
      container.scrollTop = target.offsetTop - container.offsetTop
    }
  }

  /** Переключить вкладку. Поиск сбрасываем: слово, набранное для эмодзи, в
   * стикерах почти наверняка ничего не найдёт, и человек увидел бы пустоту
   * вместо набора, за которым переключался. */
  const switchMode = (next: PickerMode) => {
    if (next === mode) return
    setMode(next)
    setQuery('')
    setActiveSection(next === 'emoji' ? EMOJI_CATEGORIES[0].id : '')
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    searchRef.current?.focus()
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

  /** Могу ли я удалить/переименовать это — право «Управление выражениями» на
   * сервере, которому оно принадлежит. Ищем по серверу самого объекта, а не по
   * активной вкладке: в поиске эмодзи и стикеры с разных серверов лежат в
   * одной сетке вперемешку. */
  const canManageServer = (serverId: number | null): boolean =>
    serverId === null
      ? false // базовый набор стикеров — ничей, из пикера его не трогают
      : servers.find((s) => s.id === serverId)?.canManage ?? false

  const canManageEmoji = (emoji: CustomEmoji) => canManageServer(emoji.server)

  const packOf = (sticker: Sticker): StickerPack | undefined =>
    stickerPacks.find((p) => p.id === sticker.pack)

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
        setMenu({ emoji, ...menuPoint(e) })
      }}
    >
      {/* play="hover" — в сетке анимация запускается наведением: это ровно
          тот момент, когда на эмодзи смотрят и выбирают. */}
      <CustomEmojiImage id={emoji.id} emoji={emoji} size={26} />
    </button>
  )

  const renderSticker = (sticker: Sticker) => (
    <button
      key={sticker.id}
      type="button"
      className="sticker-cell"
      title={sticker.name}
      onClick={() => onPickSticker?.(sticker)}
      onContextMenu={(e) => {
        if (!canManageServer(packOf(sticker)?.server ?? null)) return
        e.preventDefault()
        setMenu({ sticker, ...menuPoint(e) })
      }}
    >
      {/* play="never" — в сетке стикеры не анимируются вообще: десяток
          крупных анимаций разом превращает панель в мельтешение, а выбирают
          стикер по рисунку. Анимация начнётся уже в ленте, после отправки. */}
      <StickerImage id={sticker.id} sticker={sticker} size={STICKER_CELL} play="never" />
    </button>
  )

  /** Удалить эмодзи прямо из пикера — то же самое, что и вкладка «Эмодзи» в
   * настройках сервера (ServerSettingsModal), только без похода туда:
   * набор общий (customEmojiStore), обновление увидят все, кто открыл
   * настройки, и наоборот. */
  const handleDeleteEmoji = async (emoji: CustomEmoji) => {
    setMenu(null)
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

  const handleDeleteSticker = async (sticker: Sticker) => {
    setMenu(null)
    const serverId = packOf(sticker)?.server
    if (!serverId) return
    if (!window.confirm(`Удалить стикер «${sticker.name}»? Он пропадёт у всех.`)) {
      return
    }
    try {
      await api.deleteSticker(serverId, sticker.id)
      // Как и с эмодзи: не ждём события по WebSocket, убираем из реестра сами.
      const remaining = stickerStore
        .getPacks()
        .filter((p) => p.server === serverId)
        .map((p) => ({ ...p, stickers: p.stickers.filter((s) => s.id !== sticker.id) }))
        .filter((p) => p.stickers.length > 0)
      stickerStore.setServerPacks(serverId, remaining)
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
        setMenu(null)
      }}
    >
      {onPickSticker && (
        <div className="picker-modes">
          <button
            type="button"
            className={`picker-mode ${mode === 'stickers' ? 'active' : ''}`}
            onClick={() => switchMode('stickers')}
          >
            Стикеры
          </button>
          <button
            type="button"
            className={`picker-mode ${mode === 'emoji' ? 'active' : ''}`}
            onClick={() => switchMode('emoji')}
          >
            Эмодзи
          </button>
        </div>
      )}

      <div className="emoji-picker-search">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'stickers' ? 'Поиск стикеров' : 'Поиск эмодзи'}
        />
      </div>

      {!isSearching && mode === 'emoji' && (
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

      {!isSearching && mode === 'stickers' && (
        <div className="emoji-picker-tabs">
          {canAddSticker && (
            <button
              type="button"
              className="emoji-tab emoji-tab-add"
              title="Загрузить стикер"
              onClick={() => setStickerUploadOpen(true)}
            >
              <Plus size={16} />
            </button>
          )}
          <EmojiTabStrip>
            {stickerPacks.length === 0 ? (
              <span className="emoji-tabs-hint">
                {canAddSticker ? 'Стикеры — сюда' : 'Стикеров пока нет'}
              </span>
            ) : (
              stickerPacks.map((pack) => {
                const id = `${PACK_SECTION}${pack.id}`
                // Значок вкладки — первый стикер набора: у набора своей
                // картинки нет, а рисунок узнаётся быстрее подписи.
                const cover = pack.stickers[0]
                return (
                  <button
                    key={pack.id}
                    type="button"
                    className={`emoji-tab emoji-tab-pack ${
                      activeSection === id ? 'active' : ''
                    }`}
                    title={pack.name}
                    onClick={() => scrollToSection(id)}
                  >
                    {cover ? (
                      <StickerImage
                        id={cover.id}
                        sticker={cover}
                        size={24}
                        play="never"
                      />
                    ) : (
                      <span className="emoji-tab-initial">
                        {pack.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </EmojiTabStrip>
        </div>
      )}

      <div
        className="emoji-picker-scroll"
        ref={scrollRef}
        onMouseDown={gridDrag.onMouseDown}
        onClickCapture={gridDrag.onClickCapture}
      >
        {mode === 'stickers' ? (
          isSearching ? (
            stickerResults.length === 0 ? (
              <div className="emoji-empty">Ничего не нашлось</div>
            ) : (
              <div className="sticker-grid">{stickerResults.map(renderSticker)}</div>
            )
          ) : stickerPacks.length === 0 ? (
            <div className="emoji-empty">
              Стикеров пока нет.
              {canAddSticker && ' Загрузите первый кнопкой «+».'}
            </div>
          ) : (
            stickerPacks.map((pack) => (
              <div key={pack.id} data-section={`${PACK_SECTION}${pack.id}`}>
                <div className="emoji-category-label">
                  {pack.name}
                  {pack.server === null && <span className="pack-badge">базовый</span>}
                </div>
                <div className="sticker-grid">{pack.stickers.map(renderSticker)}</div>
              </div>
            ))
          )
        ) : isSearching ? (
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

      {menu && (
        <div
          className="profile-popup emoji-context-menu"
          style={{ left: menu.x, top: menu.y }}
          // Иначе клик по «Удалить» долетел бы до onClick панели ВЫШЕ этого
          // элемента в дереве — не страшно (та лишь погасила бы уже погашенное
          // меню), но и не нужно.
          onClick={(e) => e.stopPropagation()}
        >
          <div className="profile-popup-label">
            {menu.emoji ? `:${menu.emoji.name}:` : menu.sticker.name}
          </div>
          <div className="profile-popup-menu">
            <button
              type="button"
              className="profile-popup-item profile-popup-item-danger"
              onClick={() =>
                menu.emoji
                  ? void handleDeleteEmoji(menu.emoji)
                  : void handleDeleteSticker(menu.sticker)
              }
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

      {stickerUploadOpen && (
        <StickerEditorModal
          targets={uploadTargets}
          onClose={() => setStickerUploadOpen(false)}
          // Только что собранный стикер сразу отправляем туда, ради чего пикер
          // и открывали, — как редактор эмодзи вставляет свой результат.
          onCreated={(sticker) => onPickSticker?.(sticker)}
        />
      )}
    </div>
  )
}

/** Куда поставить маленькое меню «Удалить». Прижимаем к правому/нижнему краю
 * экрана — меню в одну строку, большого запаса считать не нужно (в отличие от
 * больших контекстных меню вроде ParticipantContextMenu). */
function menuPoint(e: React.MouseEvent): { x: number; y: number } {
  return {
    x: Math.min(e.clientX, window.innerWidth - 180),
    y: Math.min(e.clientY, window.innerHeight - 90),
  }
}
