import { useState, MouseEvent as ReactMouseEvent } from 'react'
import { Server } from '../api'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

/** Карточка-подсказка справа от пилюли: имя жирным + необязательные строки. */
interface RailHint {
  name: string
  lines: string[]
  top: number
  left: number
}

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
  const [hint, setHint] = useState<RailHint | null>(null)

  const showHint = (
    e: ReactMouseEvent<HTMLButtonElement>,
    name: string,
    lines: string[] = [],
  ) => {
    const r = e.currentTarget.getBoundingClientRect()
    // position: fixed — рельса скроллится и обрезает всё внутри себя.
    setHint({ name, lines, top: r.top + r.height / 2, left: r.right + 12 })
  }
  const hideHint = () => setHint(null)

  return (
    <nav className="server-rail" onScroll={hideHint}>
      <button
        className={`rail-pill home ${activeId == null ? 'active' : ''}`}
        onMouseEnter={(e) => showHint(e, APP_NAME)}
        onMouseLeave={hideHint}
        onClick={onHome}
      >
        {APP_NAME.charAt(0)}
      </button>
      <div className="rail-divider" />

      {servers.map((s) => (
        <button
          key={s.id}
          className={`rail-pill ${activeId === s.id ? 'active' : ''}`}
          // Подсказка при наведении — имя, особенности и описание сервера
          // (см. вкладку «Профиль» редактора сервера).
          onMouseEnter={(e) =>
            showHint(e, s.name, [s.tags?.join(' · ') || '', s.description || ''].filter(Boolean))
          }
          onMouseLeave={hideHint}
          onClick={() => onSelect(s)}
        >
          {s.icon ? (
            <img className="rail-pill-icon" src={s.icon} alt="" />
          ) : (
            serverInitials(s.name)
          )}
        </button>
      ))}

      <button
        className="rail-pill add"
        onMouseEnter={(e) => showHint(e, 'Создать сервер')}
        onMouseLeave={hideHint}
        onClick={onCreate}
      >
        +
      </button>
      <button
        className="rail-pill explore"
        onMouseEnter={(e) => showHint(e, 'Найти сервер')}
        onMouseLeave={hideHint}
        onClick={onDiscover}
      >
        ⌕
      </button>

      {hint && (
        <div className="rail-tooltip" role="tooltip" style={{ top: hint.top, left: hint.left }}>
          <span className="rail-tooltip-name">{hint.name}</span>
          {hint.lines.map((line, i) => (
            <span key={i} className="rail-tooltip-sub">
              {line}
            </span>
          ))}
        </div>
      )}
    </nav>
  )
}
