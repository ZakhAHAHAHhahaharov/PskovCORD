/**
 * Определение «упомянули ли меня» в тексте сообщения — используется, чтобы
 * решать, поднимать ли непрочитанное/бейдж при notification_level='mentions'
 * (см. web/src/components/AppShell.tsx computeNotice).
 *
 * Никакой отдельной разметки/парсинга на бэкенде нет: упоминание — это
 * просто текст вида "@Ник" или "@ИмяРоли" (тот же формат, что уже вставляет
 * «Упомянуть» в контекстном меню участника, см. AppShell.handleMention).
 * Разбор происходит здесь же, на клиенте, в момент прихода сообщения.
 *
 * Три вида упоминаний:
 *   - личное: "@мойник" — всегда считается, ограничений нет;
 *   - "@all"/"@here" — считается, если получатель не включил ignoreAtHere;
 *   - "@ИмяРоли" — считается, если получатель ДЕРЖИТ эту роль, роль не
 *     подавлена suppressRoleMentions, и (если известны роли автора) у автора
 *     есть право её пинговать (Role.mention_permission/mentionable_by).
 *
 * Точность проверки "у автора есть право" зависит от того, известны ли его
 * роли (authorRoleIds). Для СЕЙЧАС ОТКРЫТОГО сервера AppShell держит полный
 * ростер (members, с role_ids) — там точная проверка. Для ФОНОВЫХ серверов
 * (сообщение пришло, пока открыт другой сервер/канал) держать полный ростер
 * каждого сервера было бы отдельным дорогим кэшем ради редкого сценария —
 * поэтому authorRoleIds там передаётся пустым, и проверка "имеет ли право"
 * НЕ применяется: достаточно самого факта "@ИмяРоли" + что я держу эту роль.
 * Худший случай — редкий ложноположительный бейдж непрочитанного на фоновом
 * сервере, что не критично для чисто рекомендательного индикатора.
 */
import { Role } from './api'

export interface MentionContext {
  myUsername: string
  /** id ролей, которые Я держу на этом сервере. */
  myRoleIds: number[]
  /** id ролей АВТОРА сообщения — пусто, если неизвестны (см. докстринг). */
  authorRoleIds: number[]
  roles: Role[]
  ignoreAtHere: boolean
  suppressRoleMentions: boolean
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Символ "слова" — латиница/кириллица/цифры/подчёркивание. Нужен, чтобы
// "@Ник" не срабатывал внутри "@Никита" и чтобы не сработать на email-адресах
// вида "name@nickname.com" (перед "@" стоит буква — не начало упоминания).
const WORD_CHAR = 'a-zA-Zа-яА-ЯёЁ0-9_'

function mentionsToken(content: string, token: string): boolean {
  if (!token) return false
  const pattern = new RegExp(
    `(^|[^${WORD_CHAR}@])@${escapeRegExp(token)}(?![${WORD_CHAR}])`,
    'i',
  )
  return pattern.test(content)
}

function roleMentionAllowed(role: Role, authorRoleIds: number[]): boolean {
  if (authorRoleIds.length === 0) return true // см. докстринг — роли автора неизвестны
  if (role.mention_permission === 'everyone') return true
  return role.mentionable_by.some((id) => authorRoleIds.includes(id))
}

export function isMentioned(content: string, ctx: MentionContext): boolean {
  if (mentionsToken(content, ctx.myUsername)) return true

  if (!ctx.ignoreAtHere && (mentionsToken(content, 'all') || mentionsToken(content, 'here'))) {
    return true
  }

  if (!ctx.suppressRoleMentions) {
    for (const roleId of ctx.myRoleIds) {
      const role = ctx.roles.find((r) => r.id === roleId)
      if (!role) continue
      if (!mentionsToken(content, role.name)) continue
      if (roleMentionAllowed(role, ctx.authorRoleIds)) return true
    }
  }

  return false
}
