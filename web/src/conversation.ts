import { Conversation } from './api'
import { displayNameOf } from './nicknames'

/** Как называется беседа в интерфейсе. Собеседников зовём так же, как везде,
 * — с учётом моего никнейма для них (см. nicknames.ts): имя в шапке чата и в
 * списке диалогов должно совпадать с тем, что стоит в списке друзей. */
export function conversationDisplayName(c: Conversation): string {
  if (c.kind === 'group') {
    return c.name || c.participants.map(displayNameOf).join(', ') || 'Группа'
  }
  return c.participants[0] ? displayNameOf(c.participants[0]) : 'Личное сообщение'
}
