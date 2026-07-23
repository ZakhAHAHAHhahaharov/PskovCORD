import { Channel, Member } from '../api'
import Avatar from './Avatar'
import { useVoice } from '../voice'

export default function MembersList({
  members,
  channels,
}: {
  members: Member[]
  channels: Channel[]
}) {
  const { speakingUserIds } = useVoice()
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)

  const channelName = (id: string | null) => {
    if (!id) return null
    const ch = channels.find((c) => String(c.id) === id)
    return ch ? ch.name : null
  }

  const renderMember = (m: Member) => {
    const voice = channelName(m.voice_channel)
    const speaking = speakingUserIds.has(m.id)
    return (
      <div key={m.id} className="member-row">
        <Avatar
          name={m.username}
          color={m.avatar_color}
          size={32}
          online={m.online}
          showStatus
          speaking={speaking}
        />
        <div className="member-info">
          <span className={`member-name ${m.online ? '' : 'dim'} ${speaking ? 'speaking' : ''}`}>
            {m.username}
          </span>
          {voice && <span className="member-voice">🔊 {voice}</span>}
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
