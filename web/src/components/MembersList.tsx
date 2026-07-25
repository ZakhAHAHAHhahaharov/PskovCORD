import { MouseEvent as ReactMouseEvent } from 'react'
import { Volume2 } from 'lucide-react'
import { Channel, Member } from '../api'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'

export default function MembersList({
  members,
  channels,
  onOpenProfile,
}: {
  members: Member[]
  channels: Channel[]
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)

  const channelName = (id: string | null) => {
    if (!id) return null
    const ch = channels.find((c) => String(c.id) === id)
    return ch ? ch.name : null
  }

  const renderMember = (m: Member) => {
    const voice = channelName(m.voice_channel)
    return (
      <div key={m.id} className="member-row">
        <button
          type="button"
          className="avatar-trigger"
          onClick={(e) => onOpenProfile(m, e)}
        >
          <Avatar
            name={m.username}
            color={m.avatar_color}
            image={m.avatar_image}
            size={32}
            status={m.status}
            showStatus
          />
        </button>
        <div className="member-info">
          <span
            className={`member-name profile-trigger-name ${m.online ? '' : 'dim'}`}
            onClick={(e) => onOpenProfile(m, e)}
          >
            {m.username}
          </span>
          {voice && (
            <span className="member-voice">
              <Volume2 size={12} /> {voice}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <aside className="members-list">
      {online.length > 0 && (
        <>
          <div className="member-category">В сети — {online.length}</div>
          {online.map(renderMember)}
        </>
      )}
      {offline.length > 0 && (
        <>
          <div className="member-category">Не в сети — {offline.length}</div>
          {offline.map(renderMember)}
        </>
      )}
    </aside>
  )
}
