/**
 * Простейшая Discord-подобная разметка темы канала (ChannelSettingsModal
 * «Обзор» → тулбар над textarea, и шапка канала, где эта тема показывается).
 * Больше нигде в приложении разметки нет — сообщения остаются плоским
 * текстом, поэтому парсер не переиспользуется и не тянет никакой сторонней
 * библиотеки.
 *
 * Поддерживаются четыре токена, все взаимно вложенные:
 *   **bold**, __underline__ (именно двойное подчёркивание — Discord's own
 *   convention, а не CommonMark, где __x__ тоже bold), ~~strikethrough~~,
 *   *italic*.
 *
 * Рендерится через React.createElement (не dangerouslySetInnerHTML) — весь
 * текст внутри токенов проходит обычное escaping React, XSS невозможен.
 */
import { createElement, ReactNode } from 'react'

const MARKERS: { token: string; tag: string }[] = [
  { token: '**', tag: 'strong' },
  { token: '__', tag: 'u' },
  { token: '~~', tag: 's' },
  { token: '*', tag: 'em' },
]

interface Match {
  start: number
  end: number
  tag: string
  innerStart: number
  innerEnd: number
}

/** Ищет ближайшую от `from` пару токенов. Внутри markers проверяются от
 * длинных к коротким, чтобы на "**" не сработал сначала одиночный "*". */
function findMatch(text: string, from: number): Match | null {
  for (let i = from; i < text.length; i++) {
    for (const { token, tag } of MARKERS) {
      if (text.slice(i, i + token.length) !== token) continue
      const innerStart = i + token.length
      const closeAt = text.indexOf(token, innerStart)
      if (closeAt === -1 || closeAt === innerStart) continue // пустая пара — не токен
      return { start: i, end: closeAt + token.length, tag, innerStart, innerEnd: closeAt }
    }
  }
  return null
}

function renderNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (;;) {
    const match = findMatch(text, cursor)
    if (!match) {
      if (cursor < text.length) nodes.push(text.slice(cursor))
      break
    }
    if (match.start > cursor) nodes.push(text.slice(cursor, match.start))
    const inner = text.slice(match.innerStart, match.innerEnd)
    nodes.push(
      createElement(
        match.tag,
        { key: `${keyPrefix}-${key++}` },
        renderNodes(inner, `${keyPrefix}-${key}`),
      ),
    )
    cursor = match.end
  }
  return nodes
}

/** Разбирает текст темы канала и возвращает React-узлы с применённой
 * разметкой. `keyPrefix` — чтобы ключи не конфликтовали при нескольких
 * вызовах на одной странице (топик в шапке + превью в модалке). */
export function renderSimpleMarkdown(text: string, keyPrefix: string): ReactNode[] {
  return renderNodes(text, keyPrefix)
}
