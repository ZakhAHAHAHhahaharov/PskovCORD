import { EffectiveStatus } from '../api'

type StatusDot = EffectiveStatus | 'invisible'

export default function Avatar({
  name,
  color,
  size = 32,
  online,
  status,
  showStatus = false,
}: {
  name: string
  color: string
  size?: number
  /** Устаревший способ (только online/offline) — используется, если `status` не задан. */
  online?: boolean
  /** Предпочтительно: точный статус (online/dnd/offline/invisible). */
  status?: StatusDot
  showStatus?: boolean
}) {
  const initial = (name || '?').charAt(0).toUpperCase()
  const dotStatus: StatusDot = status ?? (online ? 'online' : 'offline')
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      <div
        className="avatar"
        style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
      >
        {initial}
      </div>
      {showStatus && <span className={`status-dot ${dotStatus}`} />}
    </div>
  )
}
