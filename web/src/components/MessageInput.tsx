import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Smile, X } from 'lucide-react'
import { Attachment, ChatMessageBase, uploadAttachment } from '../api'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'

export interface MessageInputPrefill {
  /** Меняется при каждом запросе на подстановку, даже если text тот же самый
   * (например, «Упомянуть» дважды подряд одного и того же человека) — без
   * этого второй одинаковый prefill не запустил бы эффект повторно. */
  token: number
  text: string
}

/** Что отдаётся наружу при отправке. Вложения — УЖЕ загруженные (см.
 * api.uploadAttachment): к моменту нажатия Enter файлы лежат на сервере, и
 * отправка сообщения передаёт только их id. */
export interface OutgoingMessage {
  content: string
  attachments: Attachment[]
}

/** Файл в композере: от выбора до готовности к отправке. */
interface StagedFile {
  localId: string
  name: string
  size: number
  /** objectURL для превью — только у картинок, иначе null. */
  previewUrl: string | null
  /** 0..1, пока идёт загрузка. */
  progress: number
  /** Заполняется, когда файл долетел до сервера. */
  uploaded: Attachment | null
  error: string | null
  controller: AbortController
}

/** Сколько файлов можно прикрепить к одному сообщению — должно совпадать с
 * backend (chat/models.py MAX_ATTACHMENTS_PER_MESSAGE): здесь проверка ради
 * понятной ошибки, настоящая — там. */
const MAX_FILES = 10

let stagedCounter = 0

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

export default function MessageInput({
  channelName,
  onSend,
  replyTarget,
  onCancelReply,
  editTarget,
  onSaveEdit,
  onCancelEdit,
  hash = true,
  prefill,
}: {
  /** Название текстового канала/собеседника/группы для плейсхолдера. */
  channelName: string
  /** "#" перед именем — только для текстовых каналов сервера; в диалогах/группах не показываем. */
  hash?: boolean
  onSend: (message: OutgoingMessage) => void
  replyTarget: ChatMessageBase | null
  onCancelReply: () => void
  editTarget: ChatMessageBase | null
  onSaveEdit: (messageId: number, content: string) => void
  onCancelEdit: () => void
  /** Внешняя подстановка текста в поле ввода — например, «Упомянуть» из
   * контекстного меню участника голосового канала (см. AppShell.handleMention). */
  prefill?: MessageInputPrefill | null
}) {
  const [value, setValue] = useState('')
  const [staged, setStaged] = useState<StagedFile[]>([])
  const [emojiAnchor, setEmojiAnchor] = useState<EmojiPickerAnchor | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Высота textarea растёт вместе с текстом (до предела в CSS max-height,
  // дальше — собственный скролл). height:auto сначала — иначе браузер меряет
  // scrollHeight от уже растянутой высоты и никогда не даёт полю сжаться
  // обратно после удаления строк.
  const autoGrow = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])
  useEffect(autoGrow, [value, autoGrow])
  // Глубина вложенности dragenter/dragleave: события приходят и от дочерних
  // элементов, и по одному dragleave подсветка гасла бы, стоило курсору
  // проехать над кнопкой внутри зоны.
  const dragDepth = useRef(0)

  // При входе в режим редактирования подставляем текущий текст сообщения.
  useEffect(() => {
    if (editTarget) setValue(editTarget.content)
  }, [editTarget])

  useEffect(() => {
    if (!prefill) return
    setValue(prefill.text)
    inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.token])

  // objectURL держит файл в памяти, пока его явно не отпустят. Освобождаем
  // всё, что осталось, при размонтировании (переключение канала с непустым
  // композером) — иначе утекает по мегабайту на каждую выбранную картинку.
  const stagedRef = useRef<StagedFile[]>([])
  stagedRef.current = staged
  useEffect(
    () => () => {
      for (const file of stagedRef.current) {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
        file.controller.abort()
      }
    },
    [],
  )

  const updateStaged = useCallback((localId: string, patch: Partial<StagedFile>) => {
    setStaged((prev) =>
      prev.map((f) => (f.localId === localId ? { ...f, ...patch } : f)),
    )
  }, [])

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      if (!list.length) return
      setStaged((prev) => {
        const room = MAX_FILES - prev.length
        if (room <= 0) return prev
        const accepted = list.slice(0, room).map((file) => {
          const localId = `staged-${(stagedCounter += 1)}`
          const entry: StagedFile = {
            localId,
            name: file.name,
            size: file.size,
            previewUrl: file.type.startsWith('image/')
              ? URL.createObjectURL(file)
              : null,
            progress: 0,
            uploaded: null,
            error: null,
            controller: new AbortController(),
          }
          // Загрузка стартует сразу, не дожидаясь отправки сообщения: пока
          // человек дописывает текст, файл уже едет — к нажатию Enter он
          // обычно уже на сервере.
          void uploadAttachment(file, {
            signal: entry.controller.signal,
            onProgress: (fraction) => updateStaged(localId, { progress: fraction }),
          })
            .then((uploaded) => updateStaged(localId, { uploaded, progress: 1 }))
            .catch((err: Error) => {
              // Отмену не показываем ошибкой: файл уже убран из списка рукой
              // пользователя, сообщать не о чем.
              if (err.name === 'AbortError') return
              updateStaged(localId, { error: err.message })
            })
          return entry
        })
        return [...prev, ...accepted]
      })
    },
    [updateStaged],
  )

  const removeStaged = useCallback((localId: string) => {
    setStaged((prev) => {
      const target = prev.find((f) => f.localId === localId)
      if (target) {
        // Прерываем загрузку, если она ещё идёт, и отпускаем превью.
        target.controller.abort()
        if (target.previewUrl) URL.revokeObjectURL(target.previewUrl)
      }
      return prev.filter((f) => f.localId !== localId)
    })
  }, [])

  const clearStaged = useCallback(() => {
    setStaged((prev) => {
      for (const file of prev) {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
      }
      return []
    })
  }, [])

  const uploading = staged.some((f) => !f.uploaded && !f.error)
  const readyAttachments = staged
    .map((f) => f.uploaded)
    .filter((a): a is Attachment => a !== null)

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const content = value.trim()
    if (editTarget) {
      // Редактируется только текст: менять состав вложений задним числом
      // backend не умеет (в edit_message их просто нет), и делать вид, что
      // умеет, хуже, чем не предлагать.
      if (!content) return
      onSaveEdit(editTarget.id, content)
      setValue('')
      return
    }
    // Отправлять нечего, если нет ни текста, ни долетевших файлов.
    if (!content && readyAttachments.length === 0) return
    // Пока хоть один файл в пути — ждём: иначе сообщение уйдёт без него.
    if (uploading) return
    onSend({ content, attachments: readyAttachments })
    setValue('')
    clearStaged()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && editTarget) {
      onCancelEdit()
      setValue('')
      return
    }
    // Enter отправляет, Shift+Enter — перенос строки (стандартный textarea
    // ничего не отправляет по Enter сам по себе, так что перехватываем явно).
    // isComposing — чтобы Enter, подтверждающий раскладку ввода (IME, для
    // китайского/японского/корейского текста), не улетал отправкой сообщения.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  /** Вставка эмодзи в позицию курсора, а не в конец строки: курсор чаще всего
   * стоит там, где человек и хочет получить символ. */
  const insertEmoji = (emoji: string) => {
    const input = inputRef.current
    if (!input) {
      setValue((prev) => prev + emoji)
      return
    }
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? start
    const next = value.slice(0, start) + emoji + value.slice(end)
    setValue(next)
    setEmojiAnchor(null)
    // Курсор — сразу после вставленного, чтобы можно было продолжать печатать.
    // requestAnimationFrame: до перерисовки в поле ещё старое значение, и
    // setSelectionRange отработал бы по нему.
    requestAnimationFrame(() => {
      input.focus()
      const caret = start + emoji.length
      input.setSelectionRange(caret, caret)
    })
  }

  // Вставка картинки из буфера (скриншот через Ctrl+V) — самый частый способ
  // поделиться картинкой, и без этого он бы просто не работал.
  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={`message-input-wrap ${dragging ? 'dragging' : ''}`}
      onDragEnter={(e) => {
        // Только файлы: перетаскивание выделенного текста внутри страницы
        // не должно включать зону сброса.
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      {editTarget ? (
        <div className="reply-banner edit-banner">
          <span className="reply-banner-text">
            <Pencil size={13} /> Редактирование сообщения
          </span>
          <button className="reply-banner-cancel" title="Отменить (Esc)" onClick={onCancelEdit}>
            <X size={14} />
          </button>
        </div>
      ) : (
        replyTarget && (
          <div className="reply-banner">
            <span className="reply-banner-text">
              Ответ пользователю <b>{replyTarget.author.username}</b>: {replyTarget.content}
            </span>
            <button className="reply-banner-cancel" title="Отменить ответ" onClick={onCancelReply}>
              <X size={14} />
            </button>
          </div>
        )
      )}

      {staged.length > 0 && (
        <div className="staged-files">
          {staged.map((file) => (
            <div
              key={file.localId}
              className={`staged-file ${file.error ? 'staged-file-error' : ''}`}
            >
              {file.previewUrl ? (
                <img src={file.previewUrl} alt={file.name} className="staged-preview" />
              ) : (
                <div className="staged-preview staged-preview-generic">
                  {file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'ФАЙЛ'}
                </div>
              )}
              <div className="staged-file-info">
                <span className="staged-file-name" title={file.name}>
                  {file.name}
                </span>
                <span className="staged-file-meta">
                  {file.error ? file.error : formatSize(file.size)}
                </span>
                {!file.uploaded && !file.error && (
                  <div className="staged-progress">
                    <div
                      className="staged-progress-bar"
                      style={{ width: `${Math.round(file.progress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                className="staged-file-remove"
                title="Убрать файл"
                onClick={() => removeStaged(file.localId)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="message-input" onSubmit={submit}>
        {/* В режиме редактирования прикреплять нечего — состав вложений
            изменить нельзя (см. submit). */}
        {!editTarget && (
          <button
            type="button"
            className="composer-btn"
            title="Прикрепить файл"
            onClick={() => fileInputRef.current?.click()}
            disabled={staged.length >= MAX_FILES}
          >
            <Plus size={18} />
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            // Сбрасываем, иначе повторный выбор ТОГО ЖЕ файла не вызовет
            // change и файл молча не прикрепится.
            e.target.value = ''
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            editTarget ? 'Изменить сообщение…' : `Написать в ${hash ? '#' : ''}${channelName}`
          }
        />
        <button
          type="button"
          className="composer-btn"
          title="Эмодзи"
          onClick={(e) =>
            setEmojiAnchor((prev) =>
              prev ? null : { rect: e.currentTarget.getBoundingClientRect() },
            )
          }
        >
          <Smile size={18} />
        </button>
      </form>

      {uploading && <div className="composer-hint">Файлы загружаются…</div>}

      {emojiAnchor && (
        <EmojiPicker
          anchor={emojiAnchor}
          onPick={insertEmoji}
          onClose={() => setEmojiAnchor(null)}
        />
      )}
    </div>
  )
}
