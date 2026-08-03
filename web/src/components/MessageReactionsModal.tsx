import { useState } from 'react'
import { X } from 'lucide-react'
import { MentionCandidate, MessageReaction } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'
import { EmojiGlyph } from './MessageReactions'

/**
 * «Показать реакции» — модалка из контекстного меню сообщения (правый клик
 * → «Показать реакции»). Слева список эмодзи столбиком, справа — кто именно
 * поставил выбранный: сама лента реакций под сообщением показывает это
 * только текстовой подсказкой по наведению на одну пилюлю, а здесь — сразу
 * все реакции разом, с именами и аватарками.
 */
export default function MessageReactionsModal({
  reactions,
  currentUserId,
  resolveUsername,
  mentionCandidates,
  onClose,
}: {
  reactions: MessageReaction[]
  currentUserId: number
  resolveUsername: (userId: number) => string | undefined
  /** Ростер сервера или участники диалога/группы — для аватарки и цвета ника
   * в списке «кто поставил». Тот же набор, что и у MessageList. */
  mentionCandidates: MentionCandidate[]
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [active, setActive] = useState(reactions[0]?.emoji ?? null)
  const activeReaction = reactions.find((r) => r.emoji === active) ?? reactions[0] ?? null

  const byId = new Map(mentionCandidates.map((c) => [c.id, c]))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal reactions-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <h2 className="modal-title">Реакции</h2>
          <button type="button" className="icon-btn" title="Закрыть" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="reactions-modal-body">
          <div className="reactions-modal-list">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`reactions-modal-item ${r.emoji === activeReaction?.emoji ? 'active' : ''}`}
                onClick={() => setActive(r.emoji)}
              >
                <EmojiGlyph emoji={r.emoji} playing={false} />
                <span className="reaction-count">{r.count}</span>
              </button>
            ))}
          </div>

          <div className="reactions-modal-users">
            {activeReaction?.user_ids.map((id) => {
              const candidate = byId.get(id)
              const name = id === currentUserId ? 'Вы' : resolveUsername(id) ?? candidate?.username ?? 'Участник'
              return (
                <div key={id} className="reactions-modal-user">
                  <Avatar
                    name={name}
                    color={candidate?.avatar_color ?? '#5865f2'}
                    image={candidate?.avatar_image}
                    size={28}
                    userId={id}
                  />
                  <span>{name}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
