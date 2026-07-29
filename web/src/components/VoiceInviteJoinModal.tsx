import { useState } from 'react'
import { LogIn, Volume2, Users } from 'lucide-react'
import { InvitePreview } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

/**
 * Окно подтверждения по ссылке-приглашению в конкретный голосовой канал
 * (?voiceInvite=<код>, см. ChannelInviteModal/ChannelContextMenu «Копировать
 * ссылку») — в отличие от обычной ссылки сервера (которая до сих пор
 * вступает мгновенно, см. AppShell useEffect на ?invite=), здесь сначала
 * показывается предпросмотр (см. backend InvitePreview), и только явное
 * подтверждение вызывает вступление+автоподключение.
 */
export default function VoiceInviteJoinModal({
  preview,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  preview: InvitePreview | null
  loading: boolean
  error: string
  onConfirm: () => void
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [confirming, setConfirming] = useState(false)

  const confirm = async () => {
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal voice-invite-join-modal" onClick={(e) => e.stopPropagation()}>
        {loading && <p className="srv-hint">Загружаем приглашение…</p>}
        {!loading && error && <div className="login-error">{error}</div>}
        {!loading && !error && preview && (
          <>
            <Avatar name={preview.server.name} color="#5865f2" image={preview.server.icon} size={56} />
            <h2 className="modal-title">{preview.server.name}</h2>
            <p className="voice-invite-join-channel">
              <Volume2 size={15} /> {preview.channel.name}
            </p>
            <p className="invite-card-members">
              <Users size={12} /> {preview.participant_count} уже в канале
            </p>
            <p className="srv-hint">
              {preview.already_member
                ? 'Вы уже участник этого сервера — подключение сразу к каналу.'
                : 'Вы станете участником сервера и сразу подключитесь к этому голосовому каналу.'}
            </p>
            <button
              type="button"
              className="btn-primary voice-invite-join-btn"
              disabled={confirming}
              onClick={confirm}
            >
              <LogIn size={15} /> {preview.already_member ? 'Перейти в канал' : 'Вступить и подключиться'}
            </button>
          </>
        )}
        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
