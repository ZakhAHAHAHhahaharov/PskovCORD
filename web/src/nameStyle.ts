/**
 * Стиль отображаемого имени — шрифт + эффект + цвет(а), настраивается в
 * ProfileModal → «Стили» → «Стиль отображаемого имени» (см.
 * DisplayNameStyleModal.tsx). Применяется везде, где ник рисуется как текст
 * автора: MessageList (сообщения), VoiceStage (тайл участника голосового
 * канала), ProfileCardHeader (сама карточка профиля).
 *
 * Цвета — просто hex-строки на User (name_color_1/2, см. backend
 * accounts.models.User) — пусто означает "не переопределять", тогда эффект
 * рисуется обычным цветом текста темы (--text-normal), нулевой визуальный
 * дифф для тех, кто это не настраивал.
 */
import { CSSProperties } from 'react'
import { NameEffect, User } from './api'

export interface NameEffectMeta {
  id: NameEffect
  label: string
  /** Сколько цветов реально использует эффект — 1 или 2 (см. DisplayNameStyleModal:
   * ровно столько color-инпутов показывается). */
  colorCount: 1 | 2
  /** Крутится ли у эффекта CSS-анимация (см. .name-style.effect-neon/
   * .effect-cartoon в index.css) — только у них есть смысл показывать
   * слайдер скорости в DisplayNameStyleModal и выставлять --name-anim-speed
   * в styledNameProps ниже. */
  hasAnimation?: boolean
}

export const NAME_EFFECTS: NameEffectMeta[] = [
  { id: 'standard', label: 'Минимализм', colorCount: 1 },
  { id: 'gradient', label: 'Градиент', colorCount: 2, hasAnimation: true },
  { id: 'neon', label: 'Неон', colorCount: 1, hasAnimation: true },
  { id: 'cartoon', label: 'Мультфильм', colorCount: 1, hasAnimation: true },
  { id: 'highlight', label: 'Выделение', colorCount: 2 },
]

export function nameEffectMeta(effect: NameEffect): NameEffectMeta {
  return NAME_EFFECTS.find((e) => e.id === effect) ?? NAME_EFFECTS[0]
}

/** Диапазон слайдера скорости анимации (DisplayNameStyleModal) — синхронизирован
 * с backend accounts.serializers.ProfileUpdateSerializer.NAME_ANIM_SPEED_MIN/MAX,
 * значение зажимается ещё и там на случай ручного PATCH мимо слайдера. */
export const NAME_ANIM_SPEED_MIN = 0.5
export const NAME_ANIM_SPEED_MAX = 2.5
export const NAME_ANIM_SPEED_DEFAULT = 1

/** Часть User, которой достаточно для расчёта стиля — так функцию можно
 * скормить и обычному User/Member, и локальному черновику в
 * DisplayNameStyleModal (там ещё нет id/username и т.п.). */
export interface NameStyleSource {
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
  name_anim_speed: number
}

/** CSS font-family для NameFont с данным id — см. accounts.models.NameFont.family_name,
 * та же формула на бэке и фронте (синтетическое имя, не зависит от label). */
export function fontFamilyFor(nameFontId: number | null): string | undefined {
  return nameFontId ? `pc-namefont-${nameFontId}` : undefined
}

/** Контрастная обводка (мультфильм-эффект) — чёрная на светлом цвете текста,
 * белая на тёмном. Простая эвристика по относительной яркости, без точной
 * цветовой модели — тут важно "видно ли обводку", а не колориметрия.
 *
 * Белая ветка — полупрозрачная (0.6), а не чистый #fff: сплошная белая
 * обводка на тонких засечках мелкого шрифта (12–19px) светилась заметно
 * ярче самой заливки и "съедала" буквы. Чёрная ветка непрозрачная — тёмный
 * контур и так визуально мягче, той же проблемы не было. */
function pickContrastOutline(hex: string): string {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return '#000000'
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#000000' : 'rgba(255, 255, 255, 0.6)'
}

/** Класс + inline-стиль для узла с ником — className вешает
 * .name-style.effect-<effect> (см. index.css), style — переменные для этих
 * классов (--name-color-1/2) плюс fontFamily. Цвета пустые → переменные не
 * выставляются, CSS сам падает на цвет по умолчанию (у gradient/neon/cartoon/
 * highlight — var(--blurple), у standard — вообще без переопределения: там
 * цвет идёт напрямую в style.color, а не через CSS-переменную, потому что
 * "цвет по умолчанию" у standard РАЗНЫЙ в разных местах (обычный текст
 * сообщения, белый текст на тёмной плашке войса, heading-текст карточки
 * профиля) — единой CSS-переменной с одним фолбэком это не выразить, а вот
 * "просто не трогать style.color, пусть решает базовый класс места" — легко). */
export function styledNameProps(user: NameStyleSource): {
  className: string
  style: CSSProperties
} {
  const meta = nameEffectMeta(user.name_effect)
  const className = `name-style effect-${meta.id}`
  const style: CSSProperties & Record<string, string | undefined> = {
    fontFamily: fontFamilyFor(user.name_font),
  }
  if (meta.id === 'standard') {
    if (user.name_color_1) style.color = user.name_color_1
    return { className, style }
  }
  if (user.name_color_1) style['--name-color-1'] = user.name_color_1
  if (meta.colorCount === 2 && user.name_color_2) {
    style['--name-color-2'] = user.name_color_2
  }
  if (meta.id === 'cartoon' && user.name_color_1) {
    style['--name-outline-color'] = pickContrastOutline(user.name_color_1)
  }
  // Не 1 по умолчанию через CSS-фолбэк (var(--name-anim-speed, 1)) — тут
  // выставляем явно ТОЛЬКО у анимированных эффектов, чтобы у остальных
  // (gradient/highlight) переменная в style вообще не появлялась: она бы
  // всё равно ни на что не влияла (их keyframes её не используют), но
  // добавляла бы кастомное CSS-свойство в атрибут style без нужды.
  if (meta.hasAnimation) {
    style['--name-anim-speed'] = String(user.name_anim_speed || NAME_ANIM_SPEED_DEFAULT)
  }
  return { className, style }
}

/** Первая буква отображаемого имени (или username, если оно не задано) — в
 * заглавном+строчном виде, для карточек выбора шрифта (см.
 * DisplayNameStyleModal — "Аа" тем шрифтом, а не абстрактное "Aa"). */
export function nameInitialPair(user: Pick<User, 'display_name' | 'username'>): string {
  const letter = (user.display_name || user.username)[0] ?? 'A'
  return `${letter.toUpperCase()}${letter.toLowerCase()}`
}
