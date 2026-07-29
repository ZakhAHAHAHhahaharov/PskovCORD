import { X } from 'lucide-react'
import { ChatMessageBase } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

/**
 * Подтверждение удаления сообщения — карточка с превью того, что удаляется
 * (тот же приём, что у Discord), без флажка "сообщить службам" — этой фичи
 * (жалоб на сообщения) в проекте нет. Сам вызов onConfirm НЕ удаляет
 * сообщение напрямую — ставит его в 10-секундное окно отмены (см.
 * MessageList.startPendingDelete), настоящий DELETE уходит только когда оно
 * истечёт.
 *
 * Shift+клик по корзине в MessageList пропускает эту модалку целиком (см.
 * подсказку ниже) — но не сам 10-секундный отмена-таймер, это отдельная,
 * всегда действующая подстраховка.
 */
export default function DeleteMessageModal({
  message,
  timeLabel,
  onConfirm,
  onClose,
}: {
  message: ChatMessageBase
  /** Уже отформатированное время сообщения — тот же formatTime, что и в
   * самой ленте, чтобы не дублировать логику форматирования дат. */
  timeLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  useEscToClose(onClose)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal delete-message-modal" onClick={(e) => e.stopPropagation()}>
        <button className="privacy-modal-close" title="Закрыть" onClick={onClose}>
          <X size={18} />
        </button>
        <h2 className="modal-title">Удалить сообщение</h2>
        <p className="delete-message-question">Вы действительно хотите удалить это сообщение?</p>

        <div className="delete-message-preview">
          <Avatar
            name={message.author.username}
            color={message.author.avatar_color}
            image={message.author.avatar_image}
            size={32}
          />
          <div className="delete-message-preview-body">
            <div className="delete-message-preview-head">
              <span className="delete-message-preview-name">{message.author.username}</span>
              <span className="delete-message-preview-time">{timeLabel}</span>
            </div>
            {message.content && (
              <div className="delete-message-preview-text">{message.content}</div>
            )}
          </div>
        </div>

        <p className="delete-message-hint">
          Чтобы полностью обойти это подтверждение, удерживайте <b>Shift</b> при нажатии на
          «Удалить сообщение».
        </p>

        <div className="delete-message-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn-danger" onClick={onConfirm}>
            Удалить
          </button>
        </div>
      </div>
    </div>
  )
}
