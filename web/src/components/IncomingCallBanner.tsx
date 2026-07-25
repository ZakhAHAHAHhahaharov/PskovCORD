import { useEffect } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import Avatar from './Avatar'
import { playIncomingCallRing, stopIncomingCallRing } from '../sounds'

/**
 * Входящий звонок в личке/группе — плашка поверх всего (как MiniProfilePopup),
 * с трелью (см. sounds.playIncomingCallRing), пока не примут/отклонят/пока
 * звонящий не выйдет из комнаты (см. AppShell — закрывается по dm_voice_state_update
 * с in_call:false для того же conversation_id, если участников не прибавилось).
 */
export default function IncomingCallBanner({
  callerUsername,
  callerAvatarColor,
  callerAvatarImage,
  conversationLabel,
  onAccept,
  onDecline,
}: {
  callerUsername: string
  callerAvatarColor: string
  callerAvatarImage: string
  /** Название группы, либо имя звонящего повторно для личных звонков. */
  conversationLabel: string
  onAccept: () => void
  onDecline: () => void
}) {
  useEffect(() => {
    playIncomingCallRing()
    return () => stopIncomingCallRing()
  }, [])

  return (
    <div className="incoming-call-banner">
      <Avatar name={callerUsername} color={callerAvatarColor} image={callerAvatarImage} size={48} />
      <div className="incoming-call-info">
        <span className="incoming-call-title">{conversationLabel}</span>
        <span className="incoming-call-subtitle">Входящий звонок — {callerUsername}</span>
      </div>
      <div className="incoming-call-actions">
        <button
          type="button"
          className="incoming-call-btn accept"
          title="Принять"
          onClick={onAccept}
        >
          <Phone size={18} />
        </button>
        <button
          type="button"
          className="incoming-call-btn decline"
          title="Отклонить"
          onClick={onDecline}
        >
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  )
}
