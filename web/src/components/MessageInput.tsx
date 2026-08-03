import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Mic, Pencil, Plus, Smile, Sticker as StickerIcon, Trash2, X } from 'lucide-react'
import {
  Attachment,
  ChatMessageBase,
  CustomEmoji,
  MentionCandidate,
  Sticker,
  mediaUrl,
  uploadAttachment,
  uploadVoiceMessage,
} from '../api'
import {
  MAX_VOICE_MS, VoiceRecording, canRecordVoice, formatVoiceTime,
} from '../voiceRecorder'
import { STICKER_TOKEN_RE, stickerToken } from '../emoji'
import {
  domToPlainText, getCaretOffset, plainOffsetToDomPoint, renderEmojiNode, renderValueIntoDom,
  setCaretAtOffset,
} from '../composerDom'
import { ComposerDraft } from '../drafts'
import Avatar from './Avatar'
import EmojiPicker, { EmojiPickerAnchor, PickerMode } from './EmojiPicker'
import { useNickname } from '../nicknames'

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
  /** Превью — только у картинок, иначе null. objectURL для выбранного прямо
   * сейчас файла либо обычный адрес на сервере у восстановленного из
   * черновика (см. draftToStaged). */
  previewUrl: string | null
  /** Превью — наш objectURL, который надо освободить (в отличие от адреса
   * уже загруженного файла: его отзывать нечего и незачем). */
  previewOwned: boolean
  /** 0..1, пока идёт загрузка. */
  progress: number
  /** Заполняется, когда файл долетел до сервера. */
  uploaded: Attachment | null
  error: string | null
  controller: AbortController
}

/** Восстановление вложений из черновика: файлы уже лежат на сервере (грузятся
 * сразу при выборе, см. addFiles), поэтому в черновике хранятся только их
 * метаданные — обратно они разворачиваются в готовые к отправке карточки. */
function draftToStaged(attachments: Attachment[]): StagedFile[] {
  return attachments.map((a) => ({
    localId: `staged-${(stagedCounter += 1)}`,
    name: a.original_name,
    size: a.size,
    previewUrl: a.content_type.startsWith('image/') ? mediaUrl(a.url) : null,
    previewOwned: false,
    progress: 1,
    uploaded: a,
    error: null,
    controller: new AbortController(),
  }))
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

const MENTION_RESULTS_LIMIT = 6

/** Короче этого запись не отправляется вовсе — это промах по кнопке, а не
 * сообщение. */
const MIN_VOICE_MS = 500

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
  draftKey,
  loadDraft,
  saveDraft,
  mentionCandidates = [],
  canSendVoice = true,
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
  /** Идентичность получателя ("channel-5", "dm-12") — вместе с ключом на самом
   * компоненте (см. AppShell) заставляет React пересоздавать инпут при смене
   * канала/диалога, а loadDraft/saveDraft читают и пишут черновик именно этого
   * канала. Не хранится тут же локальным стейтом: черновик должен пережить
   * unmount этого инстанса (переход в другой канал, в голосовой канал и
   * обратно) и перезагрузку страницы, поэтому источник правды — снаружи,
   * в localStorage (см. drafts.ts). */
  draftKey?: string
  loadDraft?: (key: string) => ComposerDraft | undefined
  saveDraft?: (key: string, draft: ComposerDraft) => void
  /** Кандидаты на @упоминание при вводе "@ник" — ростер сервера или участники
   * диалога/группы, кому принадлежит это конкретное поле ввода. */
  mentionCandidates?: MentionCandidate[]
  /** Право «Отправление голосовых сообщений» здесь. По умолчанию true — в
   * личке и группе ролей нет вовсе, и спрашивать не у кого. */
  canSendVoice?: boolean
}) {
  const replyAuthorNickname = useNickname(replyTarget?.author.id)
  const restored = draftKey && loadDraft ? loadDraft(draftKey) : undefined
  const [value, setValue] = useState(() => restored?.text ?? '')
  const [staged, setStaged] = useState<StagedFile[]>(() =>
    draftToStaged(restored?.attachments ?? []),
  )
  // Пикер один на обе кнопки композера — «стикер» и «смайл»; отличаются они
  // только вкладкой, на которой он откроется (см. pickerMode).
  const [emojiAnchor, setEmojiAnchor] = useState<EmojiPickerAnchor | null>(null)
  const [pickerMode, setPickerMode] = useState<PickerMode>('emoji')
  const [dragging, setDragging] = useState(false)
  // Композер — contentEditable, а не textarea: только так кастомный эмодзи
  // можно показать картинкой прямо во время набора, а не токеном "<:имя:id>"
  // (браузер не умеет вставлять изображения внутрь textarea). Вся механика
  // перевода DOM ↔ плоский текст, курсора и вставки — см. composerDom.ts.
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Черновик, спрятанный на время редактирования чужого сообщения — см.
  // эффект «вход/выход из режима редактирования» ниже.
  const preEditValueRef = useRef<string | null>(null)
  // Последняя известная позиция курсора внутри editor'а — обновляется на
  // каждый ввод/клик/отпускание клавиши, пока фокус реально в редакторе.
  // Нужна, чтобы вставить эмодзи туда же, откуда его выбирали: клик по кнопке
  // «Эмодзи» или по ячейке в пикере уводит фокус из editor'а, и обычный
  // window.getSelection() к моменту вставки уже не укажет на нужное место —
  // ровно та же проблема, что раньше решалась через input.selectionStart на
  // textarea (он тоже переживает потерю фокуса, Selection в contentEditable
  // так просто не переживает).
  const savedRangeRef = useRef<Range | null>(null)

  // Черновик сохраняется целиком (текст + уже загруженные вложения) при любом
  // изменении хоть того, хоть другого — эффектом, а не из каждого места, где
  // что-то меняется: путей туда много (ввод, вставка эмодзи, подстановка
  // упоминания, добавление/удаление/дозагрузка файла), и любой забытый
  // означал бы потерянный черновик.
  //
  // Режим редактирования — исключение: в textarea тогда правка ЧУЖОГО
  // сообщения, а не черновик нового, и затирать им реальный черновик нельзя
  // (см. preEditValueRef ниже — вот что вернётся в поле после отмены).
  useEffect(() => {
    if (!draftKey || !saveDraft || editTarget) return
    // Выход из режима редактирования: editTarget уже null, но в поле ещё
    // текст правленого сообщения — черновик вернёт эффект ниже, следующим
    // рендером. Записать сейчас значило бы подменить черновик чужим текстом.
    if (preEditValueRef.current !== null) return
    saveDraft(draftKey, {
      text: value,
      // Только долетевшие: недогруженный файл нечем восстановить на той
      // стороне — его придётся прикрепить заново.
      attachments: staged
        .map((f) => f.uploaded)
        .filter((a): a is Attachment => a !== null),
    })
  }, [value, staged, draftKey, saveDraft, editTarget])

  // Content-Editable инициализируется ОДИН РАЗ при монтировании (черновик
  // читается тем же снимком `restored`, что и начальное значение `value`
  // выше) — дальше DOM неконтролируемый: обычный ввод правит его сам
  // браузер, а перерисовка на каждый рендер сбрасывала бы курсор на середине
  // печати (классическая проблема «управляемого» contentEditable). См.
  // applyValue ниже — единственный путь, которым содержимое подменяется
  // ЦЕЛИКОМ уже ПОСЛЕ монтирования.
  useEffect(() => {
    if (editorRef.current) renderValueIntoDom(editorRef.current, restored?.text ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** DOM → `value`. Единственное место, которое читает содержимое editor'а —
   * зовётся и после обычного ввода (onInput), и после любой программной
   * вставки. Заодно подчищает «осиротевший» <br>, который некоторые браузеры
   * оставляют в опустевшем contentEditable — без этого редактор перестаёт
   * быть по-настоящему пустым, и CSS-плейсхолдер (:empty) не появляется. */
  const syncValueFromDom = useCallback((): string => {
    const editor = editorRef.current
    if (!editor) return ''
    const next = domToPlainText(editor)
    if (next === '' && editor.childNodes.length > 0) editor.innerHTML = ''
    setValue(next)
    return next
  }, [])

  /** Запомнить текущую позицию курсора — см. savedRangeRef выше. */
  const saveSelection = useCallback(() => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.startContainer)) savedRangeRef.current = range.cloneRange()
  }, [])

  /** Полная замена содержимого — черновик, вход/выход из редактирования
   * чужого сообщения, подстановка «Упомянуть», очистка после отправки.
   * focus:true заодно ставит курсор в конец — логичное место продолжить
   * печатать сразу после программной подстановки. */
  const applyValue = useCallback((next: string, opts: { focus?: boolean } = {}) => {
    const editor = editorRef.current
    if (!editor) {
      setValue(next)
      return
    }
    renderValueIntoDom(editor, next)
    setValue(next)
    if (opts.focus) {
      editor.focus()
      setCaretAtOffset(editor, next.length)
      saveSelection()
    }
  }, [saveSelection])

  /** Вставляет узел на последнюю запомненную позицию курсора (или в конец,
   * если её нет) и переносит курсор сразу за него — единая точка вставки для
   * эмодзи (см. insertEmoji/insertCustomEmoji) и переноса строки по
   * Shift+Enter (см. handleKeyDown).
   *
   * Range.insertNode делает всю работу сам, включая разрезание текстового
   * узла пополам, если курсор стоял посреди слова — то же самое раньше textarea
   * делала сама, а тут этим приходится управлять явно. Никакого
   * requestAnimationFrame не нужно (в отличие от прежней версии на textarea):
   * вставка меняет DOM СРАЗУ, а не через цикл setState → перерисовка. */
  const insertNodeAtCaret = useCallback((node: Node) => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    let range: Range
    if (savedRangeRef.current && editor.contains(savedRangeRef.current.startContainer)) {
      range = savedRangeRef.current.cloneRange()
    } else {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false) // нет сохранённой позиции — вставляем в конец
    }
    range.deleteContents() // если на месте вставки было выделение — заменяем его
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    savedRangeRef.current = range.cloneRange()
    syncValueFromDom()
  }, [syncValueFromDom])

  /** Перенос строки по Shift+Enter — единственное место во всём компоненте,
   * где явно используется execCommand, и вот почему. Ручная сборка через
   * Range (вставить <br>, поставить курсор после — тот же приём, что у
   * insertNodeAtCaret) здесь ЛОМАЕТСЯ: если такой <br> оказывается ПОСЛЕДНИМ
   * дочерним узлом editor'а (обычное дело — Shift+Enter чаще всего жмут в
   * конце текста), Chrome схлопывает курсор обратно на строку ДО переноса —
   * устоявшаяся особенность caret вокруг замыкающего <br>, причём именно у
   * НЕГО: та же самая ручная сборка для эмодзи-плитки (обычный inline-узел,
   * не <br>) в конце текста работает нормально, проверено отдельно. Плоду
   * этой особенности следующий введённый символ улетал бы ПЕРЕД переносом
   * строки, а не после (воспроизведено и починено при разработке — см.
   * историю коммитов). execCommand('insertLineBreak') — команда, которой
   * САМ браузер пользуется для необработанного Enter, и потому этой
   * проблеме не подвержена: это его штатный путь, а не наша самодеятельная
   * эмуляция через Range. */
  const insertLineBreakAtCaret = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    if (savedRangeRef.current && editor.contains(savedRangeRef.current.startContainer)) {
      selection?.removeAllRanges()
      selection?.addRange(savedRangeRef.current)
    }
    document.execCommand('insertLineBreak')
    savedRangeRef.current =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    syncValueFromDom()
  }, [syncValueFromDom])

  // --- автокомплит @упоминаний -------------------------------------------
  // mentionStart — индекс символа "@" в value, от которого набирается запрос;
  // null — подсказка закрыта. Пересчитывается при каждом изменении текста
  // (см. onChange), не при клике/стрелках — точечная перестановка курсора
  // внутри уже набранного "@ника" не открывает подсказку заново, только сам
  // ввод.
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)

  const mentionMatches =
    mentionStart == null
      ? []
      : mentionCandidates
          .filter((c) => c.username.toLowerCase().includes(mentionQuery.toLowerCase()))
          .sort((a, b) => {
            const q = mentionQuery.toLowerCase()
            const aStarts = a.username.toLowerCase().startsWith(q) ? 0 : 1
            const bStarts = b.username.toLowerCase().startsWith(q) ? 0 : 1
            return aStarts - bStarts || a.username.localeCompare(b.username)
          })
          .slice(0, MENTION_RESULTS_LIMIT)

  const mentionOpen = mentionStart != null && mentionMatches.length > 0

  /** Ищет "@токен" непосредственно перед caret — начало строки или пробел
   * перед "@" (иначе "a@b" в середине слова считался бы началом упоминания). */
  const detectMention = useCallback((text: string, caret: number) => {
    const uptoCaret = text.slice(0, caret)
    const at = uptoCaret.lastIndexOf('@')
    if (at === -1) return null
    const before = at === 0 ? '' : uptoCaret[at - 1]
    if (before && !/\s/.test(before)) return null
    const query = uptoCaret.slice(at + 1)
    if (/\s/.test(query)) return null // пробел после "@" — токен уже закрыт
    return { start: at, query }
  }, [])

  /** Заменяет [mentionStart, caret) на "@ник ". В отличие от textarea, где это
   * была просто склейка трёх строк, здесь нужно сначала перевести оба
   * плоскотекстовых офсета в реальные точки DOM (plainOffsetToDomPoint) —
   * caret берём СВЕЖИМ через getCaretOffset, а не из состояния: строка
   * mentionQuery могла не успеть попасть в value синхронно. */
  const applyMention = (candidate: MentionCandidate) => {
    if (mentionStart == null) return
    const editor = editorRef.current
    if (!editor) return
    const caret = getCaretOffset(editor)
    const startPoint = plainOffsetToDomPoint(editor, mentionStart)
    const endPoint = plainOffsetToDomPoint(editor, caret)
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    range.deleteContents()
    const textNode = document.createTextNode(`@${candidate.username} `)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    savedRangeRef.current = range.cloneRange()
    setMentionStart(null)
    editor.focus()
    syncValueFromDom()
  }

  // Автоматического роста высоты теперь не нужно: contentEditable — блочный
  // элемент и растёт вместе с содержимым сам, до предела в CSS max-height
  // (дальше — собственный скролл) — см. .composer-editor.
  // Глубина вложенности dragenter/dragleave: события приходят и от дочерних
  // элементов, и по одному dragleave подсветка гасла бы, стоило курсору
  // проехать над кнопкой внутри зоны.
  const dragDepth = useRef(0)

  // При входе в режим редактирования подставляем текст редактируемого
  // сообщения, спрятав то, что было в поле до этого (черновик нового
  // сообщения), в preEditValueRef. При выходе (отмена/сохранение — оба
  // приводят к editTarget: null) возвращаем спрятанный текст обратно: без
  // этого несохранённый черновик пропадал бы бесследно при каждом клике на
  // "редактировать".
  useEffect(() => {
    if (editTarget) {
      preEditValueRef.current = value
      applyValue(editTarget.content)
    } else if (preEditValueRef.current !== null) {
      applyValue(preEditValueRef.current)
      preEditValueRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget])

  useEffect(() => {
    if (!prefill) return
    applyValue(prefill.text, { focus: true })
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
        if (file.previewOwned && file.previewUrl) URL.revokeObjectURL(file.previewUrl)
        // Прерываем только незавершённые загрузки: у файла, который уже
        // долетел и лежит в черновике, abort() ничего не отменяет, но и
        // звать его незачем.
        if (!file.uploaded) file.controller.abort()
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
            previewOwned: true,
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
        if (!target.uploaded) target.controller.abort()
        if (target.previewOwned && target.previewUrl) URL.revokeObjectURL(target.previewUrl)
      }
      return prev.filter((f) => f.localId !== localId)
    })
  }, [])

  const clearStaged = useCallback(() => {
    setStaged((prev) => {
      for (const file of prev) {
        if (file.previewOwned && file.previewUrl) URL.revokeObjectURL(file.previewUrl)
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
      // Не setValue('') — editTarget вот-вот станет null, и эффект выше сам
      // вернёт в поле черновик, который был тут до начала редактирования.
      return
    }
    // Отправлять нечего, если нет ни текста, ни долетевших файлов.
    if (!content && readyAttachments.length === 0) return
    // Пока хоть один файл в пути — ждём: иначе сообщение уйдёт без него.
    if (uploading) return
    onSend({ content, attachments: readyAttachments })
    // Опустевшие поле и список вложений эффект выше сохранит как пустой
    // черновик, а пустой черновик стирает запись целиком (см. drafts.ts) —
    // иначе отправленный текст вернулся бы призраком при следующем заходе
    // в этот канал.
    applyValue('')
    clearStaged()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (mentionOpen) {
      const activeIndex = Math.min(mentionActiveIndex, mentionMatches.length - 1)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionActiveIndex((activeIndex + 1) % mentionMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionActiveIndex((activeIndex - 1 + mentionMatches.length) % mentionMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyMention(mentionMatches[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionStart(null)
        return
      }
    }
    if (e.key === 'Escape' && editTarget) {
      // Не setValue('') — onCancelEdit обнулит editTarget, и эффект выше сам
      // вернёт в поле черновик, который был тут до начала редактирования.
      onCancelEdit()
      return
    }
    // Enter отправляет, Shift+Enter — перенос строки. У textarea перенос по
    // Shift+Enter был бесплатным (браузер сам так себя ведёт); у
    // contentEditable Enter в ЛЮБОМ виде норовит завести новый <div>/<p>
    // (по-разному в разных браузерах), поэтому оба случая перехватываются
    // явно, и перенос строки — ровно тот же <br>, что вставляет пикер эмодзи
    // (см. insertNodeAtCaret).
    // isComposing — чтобы Enter, подтверждающий раскладку ввода (IME, для
    // китайского/японского/корейского текста), не улетал отправкой сообщения.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (e.shiftKey) insertLineBreakAtCaret()
      else submit()
    }
  }

  /** Стандартный эмодзи — обычный unicode-символ, вставляется как текст. */
  const insertEmoji = (emoji: string) => {
    insertNodeAtCaret(document.createTextNode(emoji))
  }

  /** Кастомный эмодзи сервера — атомарная картинка-плитка (см.
   * composerDom.renderEmojiNode), а не токен "<:имя:id>" текстом: это и есть
   * весь смысл contentEditable-композера — сразу видно, что вставилось, а не
   * загадочный код. Токен появляется только когда содержимое editor'а
   * переводится в plain text для отправки/черновика (см. syncValueFromDom). */
  const insertCustomEmoji = (emoji: CustomEmoji) => {
    insertNodeAtCaret(renderEmojiNode(emoji))
  }

  /** Стикер уходит ОТДЕЛЬНЫМ сообщением прямо по клику, не заходя в поле
   * ввода. Это не «ещё один способ вставить картинку в текст», а самостоятельная
   * реплика — как в Discord и Telegram.
   *
   * Важное следствие: недописанное сообщение в поле остаётся ровно там, где
   * было, и НЕ уезжает вместе со стикером. Поэтому здесь не зовётся ни submit
   * (он отправил бы и текст, и вложения, и очистил бы композер), ни applyValue:
   * onSend получает готовый токен, а всё состояние композера остаётся
   * нетронутым — включая черновик, который эффект выше даже не перезапишет,
   * потому что value и staged не менялись.
   *
   * Заготовленный ответ (replyTarget) стикер при этом ИСПОЛЬЗУЕТ и снимает —
   * ровно как обычная отправка (см. useChannelMessages.handleSend): стикером
   * отвечают так же, как словами, и притворяться, что ответа не было, значило
   * бы отправить его «в никуда». */
  const sendSticker = (sticker: Sticker) => {
    if (editTarget) return // в режиме правки чужого текста стикеру не место
    onSend({ content: stickerToken(sticker.id), attachments: [] })
  }

  // Вставка картинки из буфера (скриншот через Ctrl+V) — самый частый способ
  // поделиться картинкой, и без этого он бы просто не работал.
  //
  // Текстовую вставку тоже приходится перехватывать явно (в отличие от
  // textarea, где ничего, кроме голого текста, вставиться и не могло):
  // contentEditable по умолчанию тащит из буфера форматирование чужой
  // страницы (жирный, цвет, ссылки) — вставляем только text/plain, как
  // обычное текстовое поле.
  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
      return
    }
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    insertNodeAtCaret(document.createTextNode(text))
  }

  /** Открыть панель выражений на нужной вкладке (или закрыть, если она уже
   * открыта на ней же).
   *
   * Координаты кнопки снимаем СРАЗУ, синхронно с кликом, а не внутри
   * функции-апдейтера setState: currentTarget у DOM-события валиден только
   * пока событие реально диспетчеризуется — если React вызовет апдейтер позже
   * (при повторной обработке хука на следующем рендере, что бывает при
   * батчинге), e.currentTarget к тому моменту уже null, и
   * .getBoundingClientRect() падал с TypeError (живой репорт из прода —
   * трейсбэк уходил именно отсюда). */
  const openPicker = (e: React.MouseEvent, mode: PickerMode) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setEmojiAnchor((prev) => (prev && pickerMode === mode ? null : { rect }))
    setPickerMode(mode)
  }

  // --- голосовое сообщение -------------------------------------------------
  // Запись живёт в ref, а не в состоянии: сам объект неизменяемый (см.
  // VoiceRecording), а перерисовка нужна на другое — таймер и индикатор
  // громкости, они и лежат в стейте.
  const recorderRef = useRef<VoiceRecording | null>(null)
  const [recordingSince, setRecordingSince] = useState<number | null>(null)
  const [recordElapsed, setRecordElapsed] = useState(0)
  const [micLevel, setMicLevel] = useState(0)
  const [voiceSending, setVoiceSending] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const recording = recordingSince !== null

  // Таймер записи. Отдельным эффектом, а не setInterval'ом внутри старта:
  // так он гарантированно снимается и при размонтировании композера
  // (переключили канал прямо во время записи).
  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => {
      const rec = recorderRef.current
      if (!rec) return
      setRecordElapsed(rec.elapsedMs)
      // Дальше предела всё равно не примут (backend обрежет длительность) —
      // останавливаемся сами и отправляем что успели, а не теряем запись.
      if (rec.elapsedMs >= MAX_VOICE_MS) void finishVoice()
    }, 200)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  // Микрофон надо отпустить в любом случае: пока дорожка потока жива, система
  // показывает «идёт запись», даже если вкладку давно переключили.
  useEffect(
    () => () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    },
    [],
  )

  const startVoice = async () => {
    setVoiceError('')
    try {
      recorderRef.current = await VoiceRecording.start(setMicLevel)
      setRecordElapsed(0)
      setRecordingSince(Date.now())
    } catch (err) {
      // Чаще всего это отказ в доступе к микрофону — сообщение браузера тут
      // невнятное, поэтому своё.
      setVoiceError(
        (err as Error).name === 'NotAllowedError'
          ? 'Микрофон недоступен — разрешите доступ в настройках браузера.'
          : `Не удалось начать запись: ${(err as Error).message}`,
      )
    }
  }

  const cancelVoice = () => {
    recorderRef.current?.cancel()
    recorderRef.current = null
    setRecordingSince(null)
    setMicLevel(0)
  }

  /** Закончить запись и отправить её ОТДЕЛЬНЫМ сообщением — как стикер (см.
   * sendSticker): текст в поле ввода и прикреплённые файлы остаются на месте,
   * голосовое к ним не примешивается. */
  const finishVoice = async () => {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    setRecordingSince(null)
    setMicLevel(0)
    const result = await rec.stop()
    // Случайное касание кнопки — не сообщение. Полсекунды это заведомо
    // меньше любого осмысленного «ага».
    if (result.durationMs < MIN_VOICE_MS) return
    setVoiceSending(true)
    try {
      const attachment = await uploadVoiceMessage(
        result.blob, result.durationMs, result.waveform,
      )
      onSend({ content: '', attachments: [attachment] })
    } catch (err) {
      setVoiceError((err as Error).message)
    } finally {
      setVoiceSending(false)
    }
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
      {mentionOpen && (
        <div className="mention-popup" onMouseDown={(e) => e.preventDefault()}>
          {mentionMatches.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`mention-popup-item ${i === Math.min(mentionActiveIndex, mentionMatches.length - 1) ? 'active' : ''}`}
              onMouseEnter={() => setMentionActiveIndex(i)}
              onClick={() => applyMention(c)}
            >
              <Avatar
                name={c.username}
                color={c.avatar_color}
                image={c.avatar_image}
                size={22}
                userId={c.id}
                showStatus
              />
              <span className="mention-popup-name">{c.username}</span>
            </button>
          ))}
        </div>
      )}

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
              {/* Токен стикера в баннере — просто слово: сырое
                  «<sticker:42>» человеку ни о чём не говорит. */}
              Ответ пользователю <b>{replyAuthorNickname || replyTarget.author.username}</b>:{' '}
              {replyTarget.content.replace(STICKER_TOKEN_RE, '[стикер]')}
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

      {/* Пока идёт запись, на месте композера — панель записи: печатать в
          этот момент всё равно нечего, а полоса с таймером и двумя понятными
          кнопками не оставляет вопросов, что происходит и как это прекратить.
          Сам композер при этом НЕ размонтируется, а прячется классом (см.
          .message-input.hidden-by-recorder): его содержимое живёт прямо в DOM
          contentEditable'а, а не в состоянии React (см. комментарий у
          renderValueIntoDom), и снос узла стёр бы недописанное сообщение —
          ровно то, чего голосовое трогать не должно. */}
      {recording && (
        <div className="voice-recorder">
          <button
            type="button"
            className="voice-recorder-cancel"
            title="Отменить запись"
            onClick={cancelVoice}
          >
            <Trash2 size={16} />
          </button>
          <span className="voice-recorder-dot" />
          <span className="voice-recorder-time">{formatVoiceTime(recordElapsed)}</span>
          {/* Живой индикатор громкости — единственная обратная связь, по
              которой видно, что микрофон вообще что-то слышит. */}
          <span className="voice-recorder-level">
            <span
              className="voice-recorder-level-fill"
              style={{ width: `${Math.min(100, micLevel)}%` }}
            />
          </span>
          <span className="voice-recorder-hint">Запись…</span>
          <button
            type="button"
            className="voice-recorder-send"
            title="Отправить голосовое"
            onClick={() => void finishVoice()}
          >
            <Check size={17} />
          </button>
        </div>
      )}

      <form
        className={`message-input ${recording ? 'hidden-by-recorder' : ''}`}
        onSubmit={submit}
      >
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
        <div
          ref={editorRef}
          className="composer-editor"
          // Контролируем содержимое сами (см. renderValueIntoDom/applyValue) —
          // предупреждение React про contentEditable+children здесь не о чем:
          // JSX ничего не передаёт в children, весь текст живёт императивно.
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={
            editTarget ? 'Изменить сообщение…' : `Написать в ${hash ? '#' : ''}${channelName}`
          }
          onInput={() => {
            const text = syncValueFromDom()
            const caret = getCaretOffset(editorRef.current!)
            const found = detectMention(text, caret)
            setMentionStart(found?.start ?? null)
            setMentionQuery(found?.query ?? '')
            setMentionActiveIndex(0)
            saveSelection()
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={saveSelection}
          onMouseUp={saveSelection}
          onBlur={saveSelection}
          onPaste={handlePaste}
        />
        {/* Стикеры слева от эмодзи — обе кнопки открывают ОДНУ И ТУ ЖЕ
            панель, каждая на своей вкладке. Повторный клик по той же кнопке
            панель закрывает, клик по соседней — переключает вкладку, не
            закрывая (иначе «промахнулся кнопкой» стоило бы двух лишних
            кликов). В режиме правки чужого сообщения стикера нет: он уходит
            отдельным сообщением, а не в правку. */}
        {!editTarget && (
          <button
            type="button"
            className="composer-btn"
            title="Стикеры"
            onClick={(e) => openPicker(e, 'stickers')}
          >
            <StickerIcon size={18} />
          </button>
        )}
        <button
          type="button"
          className="composer-btn"
          title="Эмодзи"
          onClick={(e) => openPicker(e, 'emoji')}
        >
          <Smile size={18} />
        </button>
        {/* Микрофон последний в ряду — как в Telegram и WhatsApp, где он
            стоит на месте «отправить». Нет права или браузер не умеет
            записывать — кнопки нет вовсе: кнопка, которая на нажатие отвечает
            отказом, хуже отсутствующей. В режиме правки чужого текста
            голосовому тоже не место — оно уходит отдельным сообщением. */}
        {!editTarget && canSendVoice && canRecordVoice() && (
          <button
            type="button"
            className="composer-btn"
            title="Записать голосовое"
            disabled={voiceSending}
            onClick={() => void startVoice()}
          >
            <Mic size={18} />
          </button>
        )}
      </form>

      {uploading && <div className="composer-hint">Файлы загружаются…</div>}
      {voiceSending && <div className="composer-hint">Голосовое отправляется…</div>}
      {voiceError && <div className="composer-hint composer-hint-error">{voiceError}</div>}

      {emojiAnchor && (
        <EmojiPicker
          // key: вкладка задаётся начальным состоянием внутри панели, и без
          // пересоздания клик по соседней кнопке композера её не переключил
          // бы. Заодно сбрасывается поиск и прокрутка — при переходе «стикеры
          // ⇄ эмодзи» и то, и другое всё равно ни к чему.
          key={pickerMode}
          anchor={emojiAnchor}
          mode={pickerMode}
          onPick={insertEmoji}
          onPickCustom={insertCustomEmoji}
          onPickSticker={editTarget ? undefined : sendSticker}
          // Панель сама решает, когда закрыться (Esc или левый клик мимо —
          // см. EmojiPicker); insertEmoji/insertCustomEmoji/sendSticker её
          // больше не трогают, иначе отправить подряд несколько стикеров
          // значило бы открывать панель заново на каждый.
          onClose={() => setEmojiAnchor(null)}
        />
      )}
    </div>
  )
}
