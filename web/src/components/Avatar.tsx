export default function Avatar({
  name,
  color,
  size = 32,
  online,
  showStatus = false,
}: {
  name: string
  color: string
  size?: number
  online?: boolean
  showStatus?: boolean
}) {
  const initial = (name || '?').charAt(0).toUpperCase()
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      <div
        className="avatar"
        style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
      >
        {initial}
      </div>
      {showStatus && (
        <span className={`status-dot ${online ? 'online' : 'offline'}`} />
      )}
    </div>
  )
}
