import { MouseEvent as ReactMouseEvent, useEffect, useState } from 'react'
import { Archive, Loader2, Lock, MessagesSquare } from 'lucide-react'
import { api, Channel } from '../api'
import { useEscToClose } from '../modalStack'
import { displayNameOf } from '../nicknames'
import { STICKER_TOKEN_RE } from '../emoji'
import Avatar from './Avatar'

/**
 * Все ветки канала — «Показать все ветки» из системной записи о создании
 * ветки. В сайдбаре висят только свои (см. chat.models.ThreadMember), и это
 * единственное место, где видно чужие обсуждения: затем список и нужен.
 *
 * Данные берутся отдельной ручкой, а не из уже загруженных каналов: там не
 * все — сервер отдаёт ветки по тем же правилам видимости, но полный перечень
 * канала есть только здесь (см. backend ChannelThreads.get).
 *
 * Закрытые показываются вперемешку с живыми, но помечены: список — способ
 * найти обсуждение, а не следить за активностью, и прятать половину за второй
 * вкладкой значило бы заставлять искать дважды.
 */
export default function ThreadListModal({
  channel,
  onOpenThread,
  onThreadContextMenu,
  onClose,
}: {
  channel: Channel
  onOpenThread: (thread: Channel) => void
  onThreadContextMenu: (thread: Channel, e: ReactMouseEvent) => void
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [threads, setThreads] = useState<Channel[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api.channelThreads(channel.id)
      .then((list) => {
        if (alive) setThreads(list)
      })
      .catch((e: Error) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [channel.id])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal thread-list-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Ветки канала #{channel.name}</h2>

        {error && <div className="login-error">{error}</div>}
        {threads === null && !error && (
          <div className="thread-list-empty">
            <Loader2 size={18} className="spin" /> Загружаем…
          </div>
        )}
        {threads?.length === 0 && (
          <div className="thread-list-empty">
            В этом канале ещё нет веток. Их заводят правым кликом по сообщению.
          </div>
        )}

        <div className="thread-list">
          {threads?.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`thread-list-item ${t.archived ? 'archived' : ''}`}
              onClick={() => {
                onOpenThread(t)
                onClose()
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                onThreadContextMenu(t, e)
              }}
            >
              <span className="thread-list-item-head">
                <MessagesSquare size={14} />
                <span className="thread-list-item-name">{t.name}</span>
                {t.invite_only && (
                  <Lock size={12} className="thread-list-item-badge" />
                )}
                {t.archived && (
                  <Archive size={12} className="thread-list-item-badge" />
                )}
                <span className="thread-list-item-count">{t.message_count}</span>
              </span>
              {/* Последнее сообщение — тот же смысл, что и в плашке под
                  исходным сообщением: понять, о чём там, не заходя. */}
              {t.last_message && (
                <span className="thread-list-item-preview">
                  <Avatar
                    name={t.last_message.author.username}
                    color={t.last_message.author.avatar_color}
                    image={t.last_message.author.avatar_image}
                    size={16}
                    userId={t.last_message.author.id}
                  />
                  <span className="thread-list-item-author">
                    {displayNameOf(t.last_message.author)}
                  </span>
                  <span className="thread-list-item-text">
                    {t.last_message.content.replace(STICKER_TOKEN_RE, '[стикер]')
                      || 'вложение'}
                  </span>
                </span>
              )}
              {t.joined && <span className="thread-list-item-joined">вы участник</span>}
            </button>
          ))}
        </div>

        <div className="create-channel-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
