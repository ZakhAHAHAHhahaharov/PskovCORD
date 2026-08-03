import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, RotateCw, Trash2, X } from 'lucide-react'
import { CustomEmoji, mediaUrl, uploadEmoji } from '../api'
import { EmojiServer, customEmojiStore, useCustomEmojiPacks } from '../customEmoji'
import { ALL_EMOJI, searchEmoji } from '../emoji'
import { GifFrame, openGif } from '../gif'
import { useEscToClose } from '../modalStack'
import CustomEmojiImage from './CustomEmojiImage'

/**
 * Редактор кастомного эмодзи: выбрать картинку/гифку, подогнать её в квадрат и
 * при желании наклеить сверху другие эмодзи — каждый со своим поворотом,
 * размером и прозрачностью.
 *
 * Про анимацию. Перекодировать её в браузере нечем (то же ограничение, что у
 * анимированных аватаров — см. images.fileToGifDataUrl): canvas умеет отдать
 * только один кадр. Поэтому анимация сохраняется РОВНО в одном случае — когда
 * исходную гифку не тронули: не двигали, не приближали и ничего на неё не
 * наклеили. Тогда на сервер уезжает исходный файл байт в байт, а рядом с ним
 * первый кадр статичной картинкой (он и показывается по умолчанию, см.
 * CustomEmojiImage). Любая правка означает склейку на canvas, то есть
 * статичный эмодзи — об этом честно написано прямо в редакторе, а не выясняется
 * потом.
 */

/** Сторона готового эмодзи. 128, а не 256: эмодзи нигде не рисуется крупнее
 * 44 пикселей (см. .custom-emoji-jumbo), а вес растёт квадратом стороны — и
 * упереться в лимит 256 КБ на ровном месте не хочется. */
const OUTPUT_SIZE = 128
/** Сторона холста в модалке. */
const CANVAS_SIZE = 200
/** Совпадает с backend chat/models.py MAX_EMOJI_BYTES. Здесь — чтобы сказать
 * об этом ДО загрузки; настоящая проверка на сервере. */
const MAX_EMOJI_BYTES = 256 * 1024
/** Что вообще имеет смысл читать в память. */
const MAX_SOURCE_BYTES = 20_000_000

/** Наклейка поверх базовой картинки. */
interface Layer {
  /** Стабильный ключ для React и для выбора: id эмодзи не годится, одну и ту
   * же наклейку можно добавить дважды. */
  key: number
  /** Кастомный эмодзи — рисуется картинкой. */
  emoji?: CustomEmoji
  /** Стандартный — рисуется текстом на canvas. */
  char?: string
  /** Центр наклейки в долях холста (0..1). */
  x: number
  y: number
  /** Сторона наклейки в долях холста. */
  size: number
  /** Поворот в градусах. */
  rotation: number
  opacity: number
}

let nextLayerKey = 1

export default function EmojiEditorModal({
  targets,
  onClose,
  onCreated,
}: {
  /** Серверы, куда я вправе загрузить эмодзи (право «Создавать средства
   * выражения эмоций»). Пустым сюда не приходят — кнопки «+» тогда нет. */
  targets: EmojiServer[]
  onClose: () => void
  onCreated?: (emoji: CustomEmoji) => void
}) {
  useEscToClose(onClose)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [animated, setAnimated] = useState(false)
  // Кадр, который рисуется на холсте. Для гифки это ПЕРВЫЙ кадр, взятый
  // декодером (см. gif.ts), а не «какой сейчас показывает браузер»: drawImage
  // с анимированного <img> отдаёт текущий кадр анимации, и статичная картинка
  // получалась бы каждый раз разной.
  const [baseImage, setBaseImage] = useState<CanvasImageSource | null>(null)
  const [baseSize, setBaseSize] = useState({ width: 0, height: 0 })
  const gifRef = useRef<{ frame: GifFrame; close: () => void } | null>(null)

  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [layers, setLayers] = useState<Layer[]>([])
  const [selectedKey, setSelectedKey] = useState<number | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)

  const [name, setName] = useState('')
  const [serverId, setServerId] = useState(targets[0]?.id ?? 0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const selected = layers.find((l) => l.key === selectedKey) ?? null

  // Картинку ещё не выбрали — открываем системный диалог сразу. Модалка без
  // файла это одно действие «выбери файл», и заставлять нажимать в ней ещё
  // одну кнопку незачем.
  useEffect(() => {
    if (!file) fileInputRef.current?.click()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Декодер гифки держит буфер кадров — закрываем при уходе, иначе память
  // живёт до конца жизни вкладки (та же оговорка, что в GifAvatarModal).
  useEffect(() => () => {
    gifRef.current?.frame.release()
    gifRef.current?.close()
    gifRef.current = null
  }, [])

  const loadFile = useCallback(async (chosen: File) => {
    setError('')
    if (chosen.size > MAX_SOURCE_BYTES) {
      setError('Файл слишком большой — выберите что-нибудь до 20 МБ.')
      return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(chosen)
    }).catch((err: Error) => {
      setError(err.message)
      return ''
    })
    if (!dataUrl) return

    const isGif = chosen.type === 'image/gif'
    // Гифку разбираем декодером ради стабильного первого кадра; всё
    // остальное — обычным <img>.
    if (isGif) {
      try {
        const gif = await openGif(dataUrl)
        const frame = await gif.frame(0)
        gifRef.current?.frame.release()
        gifRef.current?.close()
        gifRef.current = { frame, close: gif.close }
        setBaseImage(frame.image)
        setBaseSize({ width: frame.width, height: frame.height })
        setAnimated(gif.count > 1)
        setFile(chosen)
        setSourceUrl(dataUrl)
        if (!name) setName(suggestName(chosen.name))
        return
      } catch {
        // Гифка не разобралась — не отказ, дальше пробуем обычным путём:
        // одиночный кадр браузер нарисует и так.
      }
    }
    const img = new Image()
    img.onerror = () => setError('Файл не похож на картинку.')
    img.onload = () => {
      setBaseImage(img)
      setBaseSize({ width: img.naturalWidth, height: img.naturalHeight })
      // WEBP тоже бывает анимированным, но узнать это из <img> нечем.
      // Ошибиться здесь безобидно: «анимация сохранится» решает бэкенд по
      // содержимому файла (см. sniff_emoji), мы лишь показываем подсказку.
      setAnimated(chosen.type === 'image/webp')
      setFile(chosen)
      setSourceUrl(dataUrl)
      if (!name) setName(suggestName(chosen.name))
    }
    img.src = dataUrl
  }, [name])

  // --- отрисовка холста ------------------------------------------------------
  // Картинки наклеек грузятся асинхронно, поэтому кэш живёт в ref: без него
  // каждая перерисовка (а их десятки на один сдвиг ползунка) заводила бы новый
  // Image и мигала бы пустым местом.
  const layerImages = useRef(new Map<number, HTMLImageElement>())

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, side: number) => {
      ctx.clearRect(0, 0, side, side)
      if (baseImage && baseSize.width > 0) {
        // «Cover»: короткая сторона равна стороне холста, затем zoom и сдвиг.
        const scale =
          Math.max(side / baseSize.width, side / baseSize.height) * zoom
        const dw = baseSize.width * scale
        const dh = baseSize.height * scale
        ctx.drawImage(
          baseImage,
          (side - dw) / 2 + offset.x * side,
          (side - dh) / 2 + offset.y * side,
          dw,
          dh,
        )
      }
      for (const layer of layers) {
        ctx.save()
        ctx.globalAlpha = layer.opacity
        ctx.translate(layer.x * side, layer.y * side)
        ctx.rotate((layer.rotation * Math.PI) / 180)
        const d = layer.size * side
        if (layer.emoji) {
          const img = layerImages.current.get(layer.key)
          if (img?.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, -d / 2, -d / 2, d, d)
          }
        } else if (layer.char) {
          ctx.font = `${d}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(layer.char, 0, 0)
        }
        ctx.restore()
      }
    },
    [baseImage, baseSize, zoom, offset, layers],
  )

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) draw(ctx, CANVAS_SIZE)
  }, [draw])

  const addLayer = (payload: { emoji?: CustomEmoji; char?: string }) => {
    const layer: Layer = {
      key: nextLayerKey++,
      ...payload,
      x: 0.5,
      y: 0.5,
      size: 0.45,
      rotation: 0,
      opacity: 1,
    }
    if (payload.emoji) {
      const img = new Image()
      // Без этого canvas «пачкается» чужим origin'ом и toBlob падает: в деве
      // фронт на :5173, а /media отдаёт Django на :8000 (в проде один домен,
      // и атрибут просто ничего не меняет).
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        const ctx = canvasRef.current?.getContext('2d')
        if (ctx) draw(ctx, CANVAS_SIZE)
      }
      img.src = mediaUrl(payload.emoji.static_url)
      layerImages.current.set(layer.key, img)
    }
    setLayers((prev) => [...prev, layer])
    setSelectedKey(layer.key)
    setChooserOpen(false)
  }

  const updateSelected = (patch: Partial<Layer>) => {
    setLayers((prev) =>
      prev.map((l) => (l.key === selectedKey ? { ...l, ...patch } : l)),
    )
  }

  const removeSelected = () => {
    if (selectedKey === null) return
    layerImages.current.delete(selectedKey)
    setLayers((prev) => prev.filter((l) => l.key !== selectedKey))
    setSelectedKey(null)
  }

  // --- перетаскивание по холсту ---------------------------------------------
  // Тащим выбранную наклейку, а если не выбрано ничего — саму базовую
  // картинку. Отдельного режима «двигать фон» нет намеренно: выбор наклейки и
  // так виден в списке слоёв, а лишний переключатель в маленькой модалке
  // только запутал бы.
  const dragRef = useRef<{ x: number; y: number; layer: number | null } | null>(null)

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !baseImage) return
    dragRef.current = { x: e.clientX, y: e.clientY, layer: selectedKey }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = (e.clientX - drag.x) / CANVAS_SIZE
      const dy = (e.clientY - drag.y) / CANVAS_SIZE
      dragRef.current = { ...drag, x: e.clientX, y: e.clientY }
      if (drag.layer !== null) {
        setLayers((prev) =>
          prev.map((l) =>
            l.key === drag.layer
              ? { ...l, x: clamp(l.x + dx, 0, 1), y: clamp(l.y + dy, 0, 1) }
              : l,
          ),
        )
      } else {
        setOffset((prev) => ({
          x: clamp(prev.x + dx, -1, 1),
          y: clamp(prev.y + dy, -1, 1),
        }))
      }
    }
    const onUp = () => {
      dragRef.current = null
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Исходная гифка уезжает как есть, только если её не трогали: любая правка
  // существует лишь на canvas, а он отдаёт один кадр.
  const untouched =
    layers.length === 0 && zoom === 1 && offset.x === 0 && offset.y === 0
  const keepsAnimation = animated && untouched

  const handleSave = async () => {
    if (!file || !baseImage) return
    setError('')
    setSaving(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = OUTPUT_SIZE
      canvas.height = OUTPUT_SIZE
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas недоступен.')
      draw(ctx, OUTPUT_SIZE)
      const flat = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      )
      if (!flat) throw new Error('Не удалось собрать картинку.')

      const payload = keepsAnimation ? file : flat
      if (payload.size > MAX_EMOJI_BYTES) {
        throw new Error(
          `Получилось ${Math.round(payload.size / 1024)} КБ, а можно до ` +
            `${MAX_EMOJI_BYTES / 1024} КБ. Возьмите гифку полегче или ` +
            'с меньшим числом кадров.',
        )
      }
      const created = await uploadEmoji(
        serverId,
        name.trim(),
        payload,
        // Статичный кадр нужен только анимированному: у обычного эмодзи
        // показывать по наведению нечего, сам файл и есть статика.
        keepsAnimation ? flat : null,
      )
      // Реестр обновится и сам, событием server_emoji, но ждать его — значит
      // на пару сотен миллисекунд показать пикер без только что добавленного
      // эмодзи; для того, кто его сейчас загрузил, это выглядит как сбой.
      customEmojiStore.setServerEmoji(serverId, [
        ...(customEmojiStore.getPacks().find((p) => p.server.id === serverId)?.emoji ?? []),
        created,
      ])
      onCreated?.(created)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const nameValid = /^[A-Za-z0-9_]{2,32}$/.test(name.trim())

  return (
    <div className="modal-overlay emoji-editor-overlay" onClick={onClose}>
      <div className="modal emoji-editor" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Свой эмодзи</h2>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            // Значение сбрасываем, иначе повторный выбор ТОГО ЖЕ файла не
            // даёт события change и «Заменить картинку» молча ничего не делает.
            e.target.value = ''
            if (chosen) void loadFile(chosen)
          }}
        />

        {!baseImage ? (
          <div className="emoji-editor-empty">
            <p>Выберите PNG, GIF или WEBP — до {MAX_EMOJI_BYTES / 1024} КБ в готовом виде.</p>
            <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
              Выбрать файл
            </button>
          </div>
        ) : (
          <div className="emoji-editor-body">
            <div className="emoji-editor-stage">
              <canvas
                ref={canvasRef}
                width={CANVAS_SIZE}
                height={CANVAS_SIZE}
                className="emoji-editor-canvas"
                onMouseDown={onCanvasMouseDown}
              />
              <div className="emoji-editor-previews">
                <div className="emoji-editor-preview-box">
                  <canvas
                    width={CANVAS_SIZE}
                    height={CANVAS_SIZE}
                    ref={(el) => {
                      const ctx = el?.getContext('2d')
                      if (ctx) draw(ctx, CANVAS_SIZE)
                    }}
                    style={{ width: 32, height: 32 }}
                  />
                  <span>В чате</span>
                </div>
                {keepsAnimation && (
                  <div className="emoji-editor-preview-box">
                    <img src={sourceUrl} alt="" style={{ width: 32, height: 32 }} />
                    <span>Анимация</span>
                  </div>
                )}
              </div>
              <label className="emoji-editor-slider">
                <span>Масштаб</span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.02}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              <p className="emoji-editor-hint">
                {selected
                  ? 'Тащите наклейку мышью по квадрату.'
                  : 'Тащите картинку мышью, чтобы сдвинуть.'}
              </p>
            </div>

            <div className="emoji-editor-side">
              <label className="emoji-editor-field">
                <span>Название</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="имя_эмодзи"
                  maxLength={32}
                />
              </label>
              {name.trim() !== '' && !nameValid && (
                <p className="emoji-editor-warn">
                  От 2 до 32 символов: латиница, цифры и «_».
                </p>
              )}

              <label className="emoji-editor-field">
                <span>Куда добавить</span>
                <select
                  value={serverId}
                  onChange={(e) => setServerId(Number(e.target.value))}
                >
                  {targets.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="emoji-editor-layers">
                <div className="emoji-editor-layers-head">
                  <span>Наклейки</span>
                  <button
                    type="button"
                    className="emoji-editor-add"
                    title="Добавить эмодзи поверх"
                    onClick={() => setChooserOpen((v) => !v)}
                  >
                    <Plus size={14} />
                  </button>
                </div>

                {chooserOpen && <LayerChooser onPick={addLayer} />}

                {layers.length === 0 ? (
                  <p className="emoji-editor-hint">Пока пусто.</p>
                ) : (
                  <div className="emoji-editor-layer-list">
                    {layers.map((layer) => (
                      <button
                        key={layer.key}
                        type="button"
                        className={`emoji-editor-layer ${
                          layer.key === selectedKey ? 'active' : ''
                        }`}
                        onClick={() =>
                          setSelectedKey(layer.key === selectedKey ? null : layer.key)
                        }
                      >
                        {layer.emoji ? (
                          <CustomEmojiImage
                            id={layer.emoji.id}
                            emoji={layer.emoji}
                            size={18}
                            play="none"
                          />
                        ) : (
                          <span>{layer.char}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {selected && (
                  <div className="emoji-editor-layer-controls">
                    <label className="emoji-editor-slider">
                      <span>
                        <RotateCw size={12} /> Поворот
                      </span>
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        value={selected.rotation}
                        onChange={(e) =>
                          updateSelected({ rotation: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="emoji-editor-slider">
                      <span>Размер</span>
                      <input
                        type="range"
                        min={0.1}
                        max={1.2}
                        step={0.01}
                        value={selected.size}
                        onChange={(e) => updateSelected({ size: Number(e.target.value) })}
                      />
                    </label>
                    <label className="emoji-editor-slider">
                      <span>Прозрачность</span>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.01}
                        value={selected.opacity}
                        onChange={(e) =>
                          updateSelected({ opacity: Number(e.target.value) })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="emoji-editor-remove"
                      onClick={removeSelected}
                    >
                      <Trash2 size={13} /> Убрать наклейку
                    </button>
                  </div>
                )}
              </div>

              {animated && !keepsAnimation && (
                <p className="emoji-editor-warn">
                  Правки собираются в один кадр — эмодзи станет статичным.
                  Чтобы сохранить анимацию, уберите наклейки и верните масштаб.
                </p>
              )}
              {keepsAnimation && (
                <p className="emoji-editor-hint">
                  Анимация сохранится. В чате будет виден первый кадр, а играть
                  начнёт при наведении.
                </p>
              )}

              <button
                type="button"
                className="emoji-editor-replace"
                onClick={() => fileInputRef.current?.click()}
              >
                Заменить картинку
              </button>
            </div>
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        {baseImage && (
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !nameValid || targets.length === 0}
          >
            {saving ? <Loader2 size={15} className="spin" /> : 'Добавить эмодзи'}
          </button>
        )}
        <button className="modal-close" onClick={onClose}>
          <X size={14} /> Отмена
        </button>
      </div>
    </div>
  )
}

/** Компактный выбор эмодзи для наклейки. Не EmojiPicker: тот сам умеет
 * открывать этот редактор, и вложить его сюда значило бы получить редактор
 * внутри редактора. Здесь и нужно меньше — ни вкладок, ни «+».
 *
 * Экспортируется ради редактора стикеров (StickerEditorModal): наклейки там
 * ровно те же, и вторая копия этого списка разъезжалась бы с первой. */
export function LayerChooser({
  onPick,
}: {
  onPick: (payload: { emoji?: CustomEmoji; char?: string }) => void
}) {
  const [query, setQuery] = useState('')
  const packs = useCustomEmojiPacks()
  const q = query.trim().toLowerCase()

  const standard = useMemo(
    () => (q ? searchEmoji(query) : ALL_EMOJI).slice(0, 60),
    [q, query],
  )
  const custom = useMemo(
    () =>
      packs
        .flatMap((pack) => pack.emoji)
        .filter((emoji) => !q || emoji.name.toLowerCase().startsWith(q))
        .slice(0, 30),
    [packs, q],
  )

  return (
    <div className="emoji-editor-chooser">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск"
        autoFocus
      />
      <div className="emoji-editor-chooser-grid">
        {custom.map((emoji) => (
          <button
            key={`c${emoji.id}`}
            type="button"
            title={`:${emoji.name}:`}
            onClick={() => onPick({ emoji })}
          >
            <CustomEmojiImage id={emoji.id} emoji={emoji} size={20} play="none" />
          </button>
        ))}
        {standard.map((entry) => (
          <button
            key={entry.char}
            type="button"
            title={entry.keywords[0]}
            onClick={() => onPick({ char: entry.char })}
          >
            {entry.char}
          </button>
        ))}
      </div>
    </div>
  )
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Имя файла → предложенное имя эмодзи: то, что подойдёт под NAME_RE
 * (латиница/цифры/«_»), иначе пусто — пусть человек придумает сам. */
function suggestName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_')
  const trimmed = base.replace(/^_+|_+$/g, '').slice(0, 32)
  return trimmed.length >= 2 ? trimmed : ''
}
