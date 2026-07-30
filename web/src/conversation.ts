import { Conversation } from './api'

export function conversationDisplayName(c: Conversation): string {
  if (c.kind === 'group') {
    return c.name || c.participants.map((p) => p.username).join(', ') || 'Группа'
  }
  return c.participants[0]?.username ?? 'Личное сообщение'
}
