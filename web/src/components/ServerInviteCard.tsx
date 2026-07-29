import { Check, LogIn, Users, X } from 'lucide-react'
import { ConversationServerInvite } from '../api'
import Avatar from './Avatar'

/**
 * Приглашение на сервер, встроенное карточкой прямо в сообщение диалога —
 * вместо отдельной вкладки «Приглашения» на домашнем экране (см.
 * HomeSidebar). Автор сообщения (isAuthor) — тот, кто пригласил, и решать
 * принять/отклонить может только собеседник.
 */
export default function ServerInviteCard({
  invite,
  isAuthor,
  onAccept,
  onDecline,
  onOpen,
}: {
  invite: ConversationServerInvite
  /** Смотрит ли карточку сам пригласивший (тогда решать нечего — только ждать). */
  isAuthor: boolean
  onAccept: () => void
  onDecline: () => void
  onOpen: () => void
}) {
  const { server, channel, status } = invite
  return (
    <div className={`invite-card invite-card-${status}`}>
      <Avatar name={server.name} color="#5865f2" image={server.icon} size={40} />
      <div className="invite-card-body">
        <span className="invite-card-title">
          {channel ? `Приглашение в голосовой канал «${channel.name}»` : 'Приглашение на сервер'}
        </span>
        <span className="invite-card-server">{server.name}</span>
        <span className="invite-card-members">
          <Users size={12} /> {server.member_count}{' '}
          {server.member_count === 1 ? 'участник' : 'участников'}
        </span>
      </div>
      <div className="invite-card-actions">
        {status === 'pending' && !isAuthor && (
          <>
            <button type="button" className="btn-small" onClick={onAccept}>
              <LogIn size={14} /> Вступить
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Отклонить"
              onClick={onDecline}
            >
              <X size={15} />
            </button>
          </>
        )}
        {status === 'pending' && isAuthor && (
          <span className="invite-card-status">Ожидает ответа</span>
        )}
        {status === 'accepted' && (
          <button type="button" className="btn-small" onClick={onOpen}>
            <Check size={14} /> Открыть сервер
          </button>
        )}
        {status === 'declined' && (
          <span className="invite-card-status">Отклонено</span>
        )}
      </div>
    </div>
  )
}
