import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, RotateCw, Trash2, X } from 'lucide-react'
import { CustomEmoji, Sticker, api, mediaUrl, uploadSticker } from '../api'
import { EmojiServer } from '../customEmoji'
import { GifFrame, openGif } from '../gif'
import { useEscToClose } from '../modalStack'
import { stickerStore } from '../stickers'
import CustomEmojiImage from './CustomEmojiImage'
import { LayerChooser, clamp } from './EmojiEditorModal'

/**
 * Редактор стикера: выбрать файл, подогнать его в квадрат и при желании
 * наклеить сверху эмодзи — каждый со своим поворотом, размером и
 * прозрачностью. То же самое, что EmojiEditorModal, и намеренно теми же
 * жестами: человек, который один раз собрал себе эмодзи, не должен заново
 * разбираться, как собрать стикер.
 *
 * Отличий от редактора эмодзи три, и все — из-за природы самого стикера:
 *
 *   1. холст 320 вместо 128 (см. STICKER_SIDE на бэкенде): стикер рисуется
 *      крупно, и 128 пикселей на нём было бы видно;
 *   2. имя человеческое — «кот в шляпе», с пробелами и кириллицей: в токен
 *      сообщения оно не попадает (там только id), поэтому алфавит ему не
 *      ограничен, в отличие от эмодзи;
 *   3. Lottie и WebM редактировать нечем — canvas их не рисует. Такие файлы
 *      уезжают как есть, а вместо холста показывается превью с честной
 *      подписью, что правки к ним неприменимы.
 *
 * Про анимацию — ровно та же история, что у эмодзи: перекодировать её в
 * браузере нечем, поэтому она сохраняется только когда исходник не тронули.
 * Любая правка означает склейку на canvas, то есть статичный стикер, — об
 * этом написано прямо в редакторе, а не выясняется потом.
 */

/** Сторона готового стикера — совпадает с backend STICKER_SIDE. Больше
 * незачем: там он всё равно будет ужат до этой стороны. */
const OUTPUT_SIZE = 320
/** Сторона холста в модалке. */
const CANVAS_SIZE = 240
/** Совпадает с backend MAX_STICKER_SOURCE_BYTES — что вообще имеет смысл
 * отправлять. Итоговые 512 КБ считает сервер уже ПОСЛЕ пережатия, поэтому
 * здесь потолок именно на исходник. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

/** Наклейка поверх базовой картинки. */
interface Layer {
  key: number
  emoji?: CustomEmoji
  char?: string
  x: number
  y: number
  size: number
  rotation: number
  opacity: number
}

let nextLayerKey = 1

/** Файл, который редактировать нечем: уезжает на сервер байт в байт. */
type RawKind = 'lottie' | 'webm'

function rawKindOf(file: File): RawKind | null {
  const name = file.name.toLowerCase()
  if (file.type === 'video/webm' || name.endsWith('.webm')) return 'webm'
  if (
    file.type === 'application/json' ||
    name.endsWith('.json') ||
    name.endsWith('.tgs')
  ) {
    return 'lottie'
  }
  return null
}

export default function StickerEditorModal({
  targets,
  onClose,
  onCreated,
}: {
  /** Серверы, куда я вправе загрузить стикер (право «Создавать средства
   * выражения эмоций»). Пустым сюда не приходят — кнопки «+» тогда нет. */
  targets: EmojiServer[]
  onClose: () => void
  onCreated?: (sticker: Sticker) => void
}) {
  useEscToClose(onClose)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [rawKind, setRawKind] = useState<RawKind | null>(null)
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
  const [pack, setPack] = useState('')
  const [serverId, setServerId] = useState(targets[0]?.id ?? 0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const selected = layers.find((l) => l.key === selectedKey) ?? null
  const ready = Boolean(file) && (rawKind !== null || baseImage !== null)

  // Файла ещё нет — открываем системный диалог сразу: модалка без файла это
  // одно действие «выбери файл», и лишняя кнопка в ней ни к чему.
  useEffect(() => {
    if (!file) fileInputRef.current?.click()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Декодер гифки держит буфер кадров — закрываем при уходе, иначе память
  // живёт до конца жизни вкладки (та же оговорка, что в EmojiEditorModal).
  useEffect(() => () => {
    gifRef.current?.frame.release()
    gifRef.current?.close()
    gifRef.current = null
  }, [])

  // objectURL превью (webm) держит файл в памяти, пока его явно не отпустят.
  useEffect(() => () => {
    if (sourceUrl.startsWith('blob:')) URL.revokeObjectURL(sourceUrl)
  }, [sourceUrl])

  const loadFile = useCallback(async (chosen: File) => {
    setError('')
    if (chosen.size > MAX_SOURCE_BYTES) {
      setError(`Файл слишком большой — выберите что-нибудь до ${
        MAX_SOURCE_BYTES / 1024 / 1024} МБ.`)
      return
    }
    if (!name) setName(suggestName(chosen.name))

    const raw = rawKindOf(chosen)
    if (raw) {
      // Редактировать нечем: canvas не рисует ни Lottie, ни webm. Файл
      // уезжает как есть, холст заменяется превью.
      setRawKind(raw)
      setAnimated(true)
      setBaseImage(null)
      setFile(chosen)
      setSourceUrl(raw === 'webm' ? URL.createObjectURL(chosen) : '')
      return
    }
    setRawKind(null)

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

    // Гифку разбираем декодером ради стабильного первого кадра; всё
    // остальное — обычным <img>.
    if (chosen.type === 'image/gif') {
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
      // Ошибиться здесь безобидно: что делать с анимацией, решает бэкенд по
      // содержимому файла, мы лишь показываем подсказку.
      setAnimated(chosen.type === 'image/webp' || chosen.type === 'image/apng')
      setFile(chosen)
      setSourceUrl(dataUrl)
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
        // «Contain», а не «cover», как у эмодзи: у стикера прозрачный фон и
        // своя форма — обрезав его до квадрата, персонажу отрезало бы уши.
        // Пустые поля по краям не мешают: бэкенд вписывает картинку в
        // 320×320, сохраняя пропорции.
        const scale =
          Math.min(side / baseSize.width, side / baseSize.height) * zoom
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
  // картинку (как в редакторе эмодзи).
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

  // Исходник уезжает как есть, только если его не трогали: любая правка
  // существует лишь на canvas, а он отдаёт один кадр. Lottie и webm не
  // трогаются никогда — их и редактировать нечем.
  const untouched =
    layers.length === 0 && zoom === 1 && offset.x === 0 && offset.y === 0
  const keepsAnimation = rawKind !== null || (animated && untouched)

  const handleSave = async () => {
    if (!file || !name.trim()) return
    setError('')
    setSaving(true)
    try {
      let payload: Blob = file
      if (rawKind === null && !keepsAnimation) {
        const canvas = document.createElement('canvas')
        canvas.width = OUTPUT_SIZE
        canvas.height = OUTPUT_SIZE
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas недоступен.')
        draw(ctx, OUTPUT_SIZE)
        // PNG, а не webp: в webp его всё равно пережмёт сервер (см.
        // chat/stickers.py), а PNG из canvas выходит без потерь на всех
        // браузерах одинаково.
        const flat = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        )
        if (!flat) throw new Error('Не удалось собрать картинку.')
        payload = flat
      }
      const created = await uploadSticker(
        serverId, name.trim(), payload, pack.trim(),
      )
      // Реестр обновится и сам, событием server_stickers, но ждать его —
      // значит на пару сотен миллисекунд показать пикер без только что
      // добавленного стикера; для того, кто его сейчас загрузил, это выглядит
      // как сбой. Перечитываем наборы сервера целиком: набор мог быть только
      // что создан, и одного стикера для этого мало.
      void refreshServerPacks(serverId)
      onCreated?.(created)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay emoji-editor-overlay" onClick={onClose}>
      <div className="modal emoji-editor" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Свой стикер</h2>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/webm,.json,.tgs"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            // Значение сбрасываем, иначе повторный выбор ТОГО ЖЕ файла не
            // даёт события change и «Заменить» молча ничего не делает.
            e.target.value = ''
            if (chosen) void loadFile(chosen)
          }}
        />

        {!ready ? (
          <div className="emoji-editor-empty">
            <p>
              Картинка (PNG, JPEG, WEBP, GIF), Lottie (.json, .tgs) или WebM.
              Всё, что не Lottie и не WebM, пережмётся в WebP до 512 КБ.
            </p>
            <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
              Выбрать файл
            </button>
          </div>
        ) : (
          <div className="emoji-editor-body">
            <div className="emoji-editor-stage">
              {rawKind ? (
                // Ни холста, ни ползунков: рисовать поверх Lottie/webm нечем,
                // и показывать неработающие органы управления — врать.
                <div className="sticker-editor-raw" style={{ width: CANVAS_SIZE }}>
                  {rawKind === 'webm' ? (
                    <video src={sourceUrl} autoPlay loop muted playsInline />
                  ) : (
                    <div className="sticker-editor-raw-badge">Lottie</div>
                  )}
                  <p className="emoji-editor-hint">
                    {rawKind === 'webm' ? 'WebM' : 'Lottie'} уезжает как есть —
                    кадрировать и клеить на него нечем. Анимация сохранится.
                  </p>
                </div>
              ) : (
                <>
                  <canvas
                    ref={canvasRef}
                    width={CANVAS_SIZE}
                    height={CANVAS_SIZE}
                    className="emoji-editor-canvas sticker-editor-canvas"
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
                        style={{ width: 96, height: 96 }}
                      />
                      <span>В чате</span>
                    </div>
                    {keepsAnimation && (
                      <div className="emoji-editor-preview-box">
                        <img src={sourceUrl} alt="" style={{ width: 96, height: 96 }} />
                        <span>Анимация</span>
                      </div>
                    )}
                  </div>
                  <label className="emoji-editor-slider">
                    <span>Масштаб</span>
                    <input
                      type="range"
                      min={0.4}
                      max={2.5}
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
                </>
              )}
            </div>

            <div className="emoji-editor-side">
              <label className="emoji-editor-field">
                <span>Название</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="кот в шляпе"
                  maxLength={32}
                />
              </label>

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

              <label className="emoji-editor-field">
                <span>Набор</span>
                <input
                  value={pack}
                  onChange={(e) => setPack(e.target.value)}
                  placeholder="по умолчанию — название сервера"
                  maxLength={48}
                />
              </label>
              <p className="emoji-editor-hint">
                Набор с таким названием заведётся сам, если его ещё нет, — это
                и есть отдельная вкладка в пикере.
              </p>

              {!rawKind && (
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
              )}

              {animated && !keepsAnimation && (
                <p className="emoji-editor-warn">
                  Правки собираются в один кадр — стикер станет статичным.
                  Чтобы сохранить анимацию, уберите наклейки и верните масштаб.
                </p>
              )}
              {keepsAnimation && !rawKind && (
                <p className="emoji-editor-hint">
                  Анимация сохранится. В чате будет виден первый кадр, а играть
                  начнёт после отправки и при наведении.
                </p>
              )}

              <button
                type="button"
                className="emoji-editor-replace"
                onClick={() => fileInputRef.current?.click()}
              >
                Заменить файл
              </button>
            </div>
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        {ready && (
          <button
            className="btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim() || targets.length === 0}
          >
            {saving ? <Loader2 size={15} className="spin" /> : 'Добавить стикер'}
          </button>
        )}
        <button className="modal-close" onClick={onClose}>
          <X size={14} /> Отмена
        </button>
      </div>
    </div>
  )
}

/** Перечитать наборы сервера и положить их в реестр. Отдельной функцией: она
 * сознательно не ждётся (стикер уже загружен, и запоздавшая сетка ничего не
 * ломает) и не должна ронять сохранение своей ошибкой. */
async function refreshServerPacks(serverId: number) {
  try {
    stickerStore.setServerPacks(serverId, await api.serverStickers(serverId))
  } catch {
    // Молча: событие server_stickers по WebSocket всё равно приедет.
  }
}

/** Имя файла → предложенное название стикера. В отличие от эмодзи, чистить
 * почти нечего: алфавит не ограничен, и «кот_в_шляпе.png» превращается в
 * «кот в шляпе», а не в пустоту. */
function suggestName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 32)
}
