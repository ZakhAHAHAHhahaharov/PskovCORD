/**
 * Мост между DOM композера сообщения (contentEditable) и плоским текстом
 * сообщения — тем же, что уезжает на сервер, ложится в черновик и
 * разбирается на @упоминания.
 *
 * Композер — contentEditable, а не textarea, ради ЭТОГО модуля: только так
 * кастомный эмодзи можно показать картинкой прямо во время набора, а не
 * токеном "<:имя:id>" — браузер не умеет вставлять изображения внутрь
 * textarea. Плата за это — контролировать вручную то, что textarea давал
 * бесплатно: перевод DOM в плоский текст и обратно, позицию курсора,
 * вставку. Отсюда и весь этот файл — см. MessageInput.tsx, там же он
 * используется целиком.
 *
 * DOM композера НАМЕРЕННО плоский: прямые дети editor'а — либо текстовые
 * узлы, либо <br> (перевод строки), либо <span data-emoji-id> (атомарная,
 * contentEditable=false, плитка эмодзи). Вложенных <div>/<p> быть не должно —
 * Enter трактуется явно (см. MessageInput.handleKeyDown, там же почему), так
 * что штатно браузер новый блок никогда не создаёт. Код ниже на вложенность
 * не рассчитан: если она всё же появится (нестандартная операция браузера),
 * текст прочитается рекурсивно и не потеряется, но офсеты курсора внутри
 * такого узла считаться не будут.
 */
import { mediaUrl } from './api'
import { customEmojiStore } from './customEmoji'
import { EMOJI_TOKEN_RE, emojiToken } from './emoji'

const EMOJI_ID_ATTR = 'data-emoji-id'
const EMOJI_NAME_ATTR = 'data-emoji-name'
const EMOJI_ANIM_ATTR = 'data-emoji-animated'

function isEmojiNode(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute(EMOJI_ID_ATTR)
}

/** Атомарная плитка эмодзи внутри композера — картинка, которую нельзя зайти
 * курсором внутрь и нельзя отредактировать посимвольно (contentEditable=false
 * на самом узле при живом contentEditable=true на editor'е — стандартный
 * приём для «неделимых» вставок в contentEditable). */
export function renderEmojiNode(emoji: {
  id: number
  name: string
  animated: boolean
  static_url: string
}): HTMLSpanElement {
  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.className = 'composer-emoji'
  span.setAttribute(EMOJI_ID_ATTR, String(emoji.id))
  span.setAttribute(EMOJI_NAME_ATTR, emoji.name)
  span.setAttribute(EMOJI_ANIM_ATTR, String(emoji.animated))
  const img = document.createElement('img')
  img.src = mediaUrl(emoji.static_url)
  img.alt = `:${emoji.name}:`
  img.draggable = false
  span.appendChild(img)
  return span
}

/** Токен, закодированный в самом узле — не пересчитывается через
 * customEmojiStore на каждый вызов: узел должен читаться одинаково, даже
 * если эмодзи с тех пор удалили с сервера (реестр забудет его, атрибуты
 * узла — нет). */
function emojiNodeToken(node: HTMLElement): string {
  const id = Number(node.getAttribute(EMOJI_ID_ATTR) ?? '0')
  const name = node.getAttribute(EMOJI_NAME_ATTR) ?? ''
  const animated = node.getAttribute(EMOJI_ANIM_ATTR) === 'true'
  return emojiToken({ id, name, animated })
}

/** DOM композера → плоский текст с токенами "<:имя:id>". */
export function domToPlainText(root: Node): string {
  let text = ''
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // node, а не заранее приведённый к HTMLElement: isEmojiNode — сужающий
      // guard именно к HTMLElement, и приведение ДО вызова сделало бы ветку
      // "не подошло" типом never (сузили бы HTMLElement минус HTMLElement).
      if (isEmojiNode(node)) {
        text += emojiNodeToken(node)
      } else {
        const el = node as HTMLElement
        if (el.tagName === 'BR') text += '\n'
        else text += domToPlainText(el) // см. докстринг модуля — штатно не встречается
      }
    }
  }
  return text
}

/** «Длина» узла в терминах domToPlainText — сколько символов плоского текста
 * он даёт. Нужна, чтобы переводить координаты курсора между DOM и текстом. */
function nodePlainLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (isEmojiNode(node)) return emojiNodeToken(node).length
    const el = node as HTMLElement
    if (el.tagName === 'BR') return 1
    return domToPlainText(el).length
  }
  return 0
}

/** Плоский текст → фрагмент DOM: токены становятся плитками (см.
 * renderEmojiNode), "\n" — <br>, остальное — обычным текстом.
 *
 * Эмодзи, которого нет в реестре (ещё не долетел на старте сессии, либо
 * сервер, где меня уже нет), остаётся токеном КАК ЕСТЬ, plain-текстом:
 * безопаснее, чем гадать картинку, и ничего не теряет — тот же токен всё
 * равно уйдёт на сервер при отправке. */
export function parseValueToFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (!text) return fragment

  const pushText = (chunk: string) => {
    if (!chunk) return
    // "\n" построчно: перевод строки внутри одного текстового узла браузер
    // визуально не рисует без явного <br>.
    const lines = chunk.split('\n')
    lines.forEach((line, i) => {
      if (line) fragment.appendChild(document.createTextNode(line))
      if (i < lines.length - 1) fragment.appendChild(document.createElement('br'))
    })
  }

  EMOJI_TOKEN_RE.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EMOJI_TOKEN_RE.exec(text))) {
    const [full, , , idStr] = match
    pushText(text.slice(lastIndex, match.index))
    const emoji = customEmojiStore.lookup(Number(idStr))
    if (emoji) fragment.appendChild(renderEmojiNode(emoji))
    else pushText(full) // не резолвится — оставляем как текст, см. докстринг выше
    lastIndex = match.index + full.length
  }
  pushText(text.slice(lastIndex))
  return fragment
}

/** Полная перерисовка содержимого композера из плоского текста. Только для
 * ЦЕЛЬНОЙ подмены значения (черновик при монтировании, вход/выход из
 * редактирования чужого сообщения, подстановка «Упомянуть», очистка после
 * отправки) — НЕ на каждое нажатие клавиши: обычный ввод браузер отрабатывает
 * сам через нативный contentEditable, а перерисовка всего дерева на каждый
 * символ сбрасывала бы курсор на середине печати. */
export function renderValueIntoDom(root: HTMLElement, text: string) {
  root.innerHTML = ''
  root.appendChild(parseValueToFragment(text))
}

/** Курсор в терминах плоского текста — офсет от начала root. Строим Range от
 * начала root до текущей позиции выделения и меряем длину его содержимого
 * той же domToPlainText — обычный приём для caret-офсета в contentEditable. */
export function getCaretOffset(root: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return domToPlainText(root).length
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return domToPlainText(root).length
  const preRange = document.createRange()
  preRange.selectNodeContents(root)
  preRange.setEnd(range.startContainer, range.startOffset)
  return domToPlainText(preRange.cloneContents()).length
}

/** Обратный перевод: офсет плоского текста → точка в DOM для Range.
 * Офсет всегда указывает НА ГРАНИЦУ узла — плитка эмодзи и <br> неделимы, а
 * единственный вызывающий с «чужим» офсетом (mentionStart) целится в позицию
 * символа "@", который внутри токена эмодзи появиться не может. */
export function plainOffsetToDomPoint(
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } {
  let remaining = offset
  const children = Array.from(root.childNodes)
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i]
    const len = nodePlainLength(node)
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= len) return { node, offset: remaining }
      remaining -= len
    } else {
      // <br> или плитка эмодзи — офсет либо строго ДО них, либо строго ПОСЛЕ.
      if (remaining <= 0) return { node: root, offset: i }
      remaining -= len
      if (remaining <= 0) return { node: root, offset: i + 1 }
    }
  }
  return { node: root, offset: children.length }
}

/** Ставит курсор (схлопнутое выделение) на офсет плоского текста. */
export function setCaretAtOffset(root: HTMLElement, offset: number) {
  const { node, offset: domOffset } = plainOffsetToDomPoint(root, offset)
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(node, domOffset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
