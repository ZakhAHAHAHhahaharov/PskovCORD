import { MouseEvent as ReactMouseEvent } from 'react'
import { Volume2 } from 'lucide-react'
import { Channel, Member, Role } from '../api'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'
import UserName from './UserName'

interface RoleGroup {
  key: string
  label: string
  /** Цвет точки у заголовка группы — у «Владельца»/«Участников» его нет. */
  color?: string
  members: Member[]
}

/** Группирует по САМОЙ ВЫСОКОЙ персональной роли — участник с несколькими
 * ролями показывается только в группе верхней из них (та же логика, что и
 * у иерархии модерации на бэке, см. chat/roles.py highest_role_position).
 * Владелец — всегда своя отдельная группа сверху, даже если у него ещё и
 * есть какая-то персональная роль. Участники без персональных ролей (только
 * роль по умолчанию — она не входит в role_ids) собираются в «Участники»
 * последней группой. */
function groupByRole(members: Member[], roles: Role[], ownerId: number): RoleGroup[] {
  const groups: RoleGroup[] = []
  const consumed = new Set<number>()

  const owner = members.find((m) => m.id === ownerId)
  if (owner) {
    groups.push({ key: 'owner', label: 'Владелец', members: [owner] })
    consumed.add(owner.id)
  }

  const personalRoles = roles.filter((r) => !r.is_default).sort((a, b) => b.position - a.position)
  for (const role of personalRoles) {
    const inRole = members.filter((m) => !consumed.has(m.id) && m.role_ids.includes(role.id))
    if (inRole.length === 0) continue
    inRole.forEach((m) => consumed.add(m.id))
    groups.push({ key: `role-${role.id}`, label: role.name, color: role.color, members: inRole })
  }

  const rest = members.filter((m) => !consumed.has(m.id))
  if (rest.length > 0) groups.push({ key: 'members', label: 'Участники', members: rest })

  return groups
}

export default function MembersList({
  members,
  channels,
  roles,
  ownerId,
  onOpenProfile,
}: {
  members: Member[]
  channels: Channel[]
  /** Роли сервера — для группировки по иерархии (см. groupByRole). */
  roles: Role[]
  ownerId: number
  onOpenProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
}) {
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)
  const onlineGroups = groupByRole(online, roles, ownerId)
  const offlineGroups = groupByRole(offline, roles, ownerId)

  const channelName = (id: string | null) => {
    if (!id) return null
    const ch = channels.find((c) => String(c.id) === id)
    return ch ? ch.name : null
  }

  const renderMember = (m: Member) => {
    const voice = channelName(m.voice_channel)
    return (
      <button
        key={m.id}
        type="button"
        className="member-row"
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
        <div className="member-info">
          <UserName user={m} className={`member-name ${m.online ? '' : 'dim'}`} noScroll />
          {voice && (
            <span className="member-voice">
              <Volume2 size={12} /> {voice}
            </span>
          )}
        </div>
      </button>
    )
  }

  const renderGroup = (group: RoleGroup) => (
    <div key={group.key}>
      <div className="member-category">
        {group.color && (
          <span className="member-category-dot" style={{ background: group.color }} />
        )}
        {group.label} — {group.members.length}
      </div>
      {group.members.map(renderMember)}
    </div>
  )

  return (
    <aside className="members-list">
      {onlineGroups.map(renderGroup)}
      {offlineGroups.map(renderGroup)}
    </aside>
  )
}
