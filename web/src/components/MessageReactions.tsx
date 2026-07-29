import { SmilePlus } from 'lucide-react'
import { MessageReaction } from '../api'
import { customEmojiUrl, parseEmojiKey } from '../emoji'

/**
 * Лента реакций под сообщением.
 *
 * Своя реакция подсвечена. «Своя» вычисляется здесь, а не приходит с сервера:
 * один и тот же объект сообщения рассылается всем получателям разом, поэтому
 * поля, зависящего от получателя, в нём быть не может — сервер отдаёт
 * user_ids, клиент сверяет со своим id (см. backend reactions_payload).
 */

/** Столько РАЗНЫХ эмодзи влезает на одно сообщение — совпадает с backend
 * (chat/models.py MAX_REACTIONS_PER_MESSAGE). Здесь — только чтобы спрятать
 * кнопку «+», когда добавлять уже нечего; настоящая проверка на сервере. */
export const MAX_REACTIONS = 20

/** Один эмодзи: unicode-символ или картинка кастомного эмодзи сервера.
 * Второй ветки пока не бывает — см. emoji.ts, там же почему она есть. */
function EmojiGlyph({ emoji }: { emoji: string }) {
  const parsed = parseEmojiKey(emoji)
  if (parsed.kind === 'custom') {
    const url = customEmojiUrl(parsed.value)
    if (url) return <img className="reaction-custom" src={url} alt={emoji} />
    // Кастомный эмодзи, картинку которого не достать (удалили с сервера) —
    // показываем заглушкой, а не пустотой: счётчик рядом иначе выглядит
    // сломанным.
    return <span className="reaction-missing">□</span>
  }
  return <span>{parsed.value}</span>
}

/** A, B и C — обычное перечисление через запятую с "и" перед последним, а не
 * голый join(', ') — так подсказка читается как естественная фраза, а не
 * как список из кода. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`
}

function tooltip(
  reaction: MessageReaction,
  currentUserId: number,
  resolveUsername: (userId: number) => string | undefined,
): string {
  const names = reaction.user_ids.map((id) =>
    id === currentUserId ? 'Вы' : resolveUsername(id) ?? 'кто-то',
  )
  return `Отреагировали: ${joinNames(names)}`
}

export default function MessageReactions({
  reactions,
  currentUserId,
  resolveUsername,
  onToggle,
  onOpenPicker,
}: {
  reactions: MessageReaction[]
  currentUserId: number
  /** id участника → его ник, для попапа со списком поставивших реакцию —
   * ростер сервера или участники диалога/группы, у кого эта конкретная
   * лента сообщений (см. MessageList/AppShell). */
  resolveUsername: (userId: number) => string | undefined
  /** Клик по реакции: поставить свою, если её нет, снять — если есть. */
  onToggle: (emoji: string, mine: boolean) => void
  /** Кнопка «+» — открыть пикер; получает якорь для позиционирования. */
  onOpenPicker: (rect: DOMRect) => void
}) {
  if (reactions.length === 0) return null

  return (
    <div className="message-reactions">
      {reactions.map((reaction) => {
        const mine = reaction.user_ids.includes(currentUserId)
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={`reaction-pill hover-tip ${mine ? 'mine' : ''}`}
            data-tooltip={tooltip(reaction, currentUserId, resolveUsername)}
            onClick={() => onToggle(reaction.emoji, mine)}
          >
            <EmojiGlyph emoji={reaction.emoji} />
            <span className="reaction-count">{reaction.count}</span>
          </button>
        )
      })}
      {reactions.length < MAX_REACTIONS && (
        <button
          type="button"
          className="reaction-pill reaction-add"
          title="Добавить реакцию"
          onClick={(e) => onOpenPicker(e.currentTarget.getBoundingClientRect())}
        >
          <SmilePlus size={14} />
        </button>
      )}
    </div>
  )
}
