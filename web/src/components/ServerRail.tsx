import { Server } from '../api'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

function serverInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
}

export default function ServerRail({
  servers,
  activeId,
  onSelect,
  onCreate,
  onDiscover,
  onHome,
}: {
  servers: Server[]
  activeId: number | null
  onSelect: (s: Server) => void
  onCreate: () => void
  onDiscover: () => void
  /** Клик по «домику» — личные сообщения/друзья вместо сервера. */
  onHome: () => void
}) {
  return (
    <nav className="server-rail">
      <button
        className={`rail-pill home ${activeId == null ? 'active' : ''}`}
        title={APP_NAME}
        onClick={onHome}
      >
        {APP_NAME.charAt(0)}
      </button>
      <div className="rail-divider" />

      {servers.map((s) => (
        <button
          key={s.id}
          className={`rail-pill ${activeId === s.id ? 'active' : ''}`}
          title={s.name}
          onClick={() => onSelect(s)}
        >
          {serverInitials(s.name)}
        </button>
      ))}

      <button className="rail-pill add" title="Создать сервер" onClick={onCreate}>
        +
      </button>
      <button
        className="rail-pill explore"
        title="Найти сервер"
        onClick={onDiscover}
      >
        ⌕
      </button>
    </nav>
  )
}
