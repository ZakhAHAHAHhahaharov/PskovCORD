import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Sticker, api, uploadSticker } from '../api'
import { EmojiServer } from '../customEmoji'
import { useEscToClose } from '../modalStack'
import { stickerStore } from '../stickers'

/**
 * Загрузка стикера.
 *
 * Простая форма, а не редактор с холстом, как у эмодзи (EmojiEditorModal), и
 * это осознанно: эмодзи там кадрируют, потому что он крошечный и из чужой
 * картинки его надо ещё вырезать. Стикер рисуется целиком и крупно —
 * подгонять в нём нечего, а вся обработка (пережатие в WebP, ужатие до
 * лимита, вырезание первого кадра анимации) всё равно происходит на сервере,
 * см. backend chat/stickers.py.
 */

/** Совпадает с backend chat/models.py MAX_STICKER_BYTES. Здесь — только чтобы
 * рассказать об этом заранее; настоящий предел применяется на сервере, уже
 * ПОСЛЕ пережатия, поэтому исходник может быть заметно тяжелее. */
const MAX_STICKER_KB = 512
/** Совпадает с MAX_STICKER_SOURCE_BYTES — что вообще имеет смысл отправлять. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

export default function StickerUploadModal({
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
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [name, setName] = useState('')
  const [pack, setPack] = useState('')
  const [serverId, setServerId] = useState(targets[0]?.id ?? 0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Файла ещё нет — открываем системный диалог сразу: модалка без файла это
  // одно действие «выбери файл», и лишняя кнопка в ней ни к чему.
  useEffect(() => {
    if (!file) fileInputRef.current?.click()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // objectURL держит файл в памяти, пока его явно не отпустят.
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const chooseFile = (chosen: File) => {
    setError('')
    if (chosen.size > MAX_SOURCE_BYTES) {
      setError(`Файл слишком большой — до ${MAX_SOURCE_BYTES / 1024 / 1024} МБ.`)
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(chosen)
    // Превью только у того, что браузер покажет сам: Lottie без плеера —
    // просто JSON, и рисовать на его месте битую картинку хуже, чем ничего.
    const previewable =
      chosen.type.startsWith('image/') || chosen.type === 'video/webm'
    setPreviewUrl(previewable ? URL.createObjectURL(chosen) : '')
    // Имя по умолчанию — из имени файла: чаще всего оно и есть то, что нужно.
    if (!name) setName(chosen.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 32))
  }

  const handleSave = async () => {
    if (!file || !name.trim()) return
    setSaving(true)
    setError('')
    try {
      const created = await uploadSticker(serverId, name.trim(), file, pack.trim())
      // Реестр обновится и событием server_stickers по WebSocket, но не ждём
      // его: тому, кто только что загрузил, стикер должен появиться в сетке
      // сразу. Запрашиваем наборы сервера целиком — набор мог быть только что
      // создан, и одного стикера для этого мало.
      void refreshServerPacks(serverId)
      onCreated?.(created)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const isVideo = file?.type === 'video/webm'

  return (
    <div className="modal-overlay emoji-editor-overlay" onClick={onClose}>
      <div className="modal sticker-upload" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Новый стикер</h2>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/webm,.json,.tgs"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            // Значение сбрасываем, иначе повторный выбор ТОГО ЖЕ файла не даёт
            // события change и «Заменить» молча ничего не делает.
            e.target.value = ''
            if (chosen) chooseFile(chosen)
          }}
        />

        {!file ? (
          <div className="emoji-editor-empty">
            <p>
              Картинка (PNG, JPEG, WEBP, GIF), Lottie (.json, .tgs) или WebM.
              Всё, что не Lottie и не WebM, пережмётся в WebP до {MAX_STICKER_KB} КБ.
            </p>
            <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
              Выбрать файл
            </button>
          </div>
        ) : (
          <>
            <div className="sticker-upload-preview">
              {previewUrl ? (
                isVideo ? (
                  <video src={previewUrl} autoPlay loop muted playsInline />
                ) : (
                  <img src={previewUrl} alt="" />
                )
              ) : (
                <div className="sticker-upload-nopreview">Lottie</div>
              )}
            </div>

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
              <select value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
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
              Набор с таким названием заведётся сам, если его ещё нет, — это и
              есть отдельная вкладка в пикере.
            </p>

            <button
              type="button"
              className="emoji-editor-replace"
              onClick={() => fileInputRef.current?.click()}
            >
              Заменить файл
            </button>
          </>
        )}

        {error && <div className="login-error">{error}</div>}

        {file && (
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

/** Перечитать наборы сервера и положить их в реестр. Отдельной функцией, а не
 * внутри handleSave: она сознательно не ждётся (стикер уже загружен, и
 * запоздавшая сетка ничего не ломает) и не должна ронять сохранение своей
 * ошибкой. */
async function refreshServerPacks(serverId: number) {
  try {
    stickerStore.setServerPacks(serverId, await api.serverStickers(serverId))
  } catch {
    // Молча: событие server_stickers по WebSocket всё равно приедет.
  }
}
