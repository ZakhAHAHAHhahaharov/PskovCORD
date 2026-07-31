import { useState, MouseEvent as ReactMouseEvent } from 'react'
import { BellOff } from 'lucide-react'
import { Server } from '../api'
import { useLongPress } from '../hooks/useLongPress'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

/** Карточка-подсказка справа от пилюли: имя жирным + необязательные строки. */
interface RailHint {
  name: string
  lines: string[]
  top: number
  left: number
}

/** Заглушка вместо значка сервера — те же инициалы, что и в рейле, где бы
 * сервер ни рисовался (см. ConversationContextMenu). */
export function serverInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
}

function RailServerPill({
  server: s,
  active,
  unread,
  muted,
  onSelect,
  onContextMenu,
  onHint,
  onHideHint,
}: {
  server: Server
  active: boolean
  unread: boolean
  muted: boolean
  onSelect: (s: Server) => void
  onContextMenu: (s: Server, e: ReactMouseEvent) => void
  onHint: (e: ReactMouseEvent<HTMLButtonElement>, name: string, lines?: string[]) => void
  onHideHint: () => void
}) {
  // Long-press — тач-аналог правого клика ниже, тот же колбэк (тот на
  // клиенте читает только .clientX/.clientY, см. AppShell).
  const longPress = useLongPress((point) => onContextMenu(s, point as unknown as ReactMouseEvent))
  return (
    <button
      className={`rail-pill ${active ? 'active' : ''}`}
      // Подсказка при наведении — имя, особенности и описание сервера
      // (см. вкладку «Профиль» редактора сервера).
      onMouseEnter={(e) =>
        onHint(e, s.name, [s.tags?.join(' · ') || '', s.description || ''].filter(Boolean))
      }
      onMouseLeave={onHideHint}
      onClick={() => onSelect(s)}
      onContextMenu={(e) => {
        e.preventDefault()
        onHideHint()
        onContextMenu(s, e)
      }}
      {...longPress}
    >
      {s.icon ? (
        <img className="rail-pill-icon" src={s.icon} alt="" />
      ) : (
        serverInitials(s.name)
      )}
      {unread && !muted && <span className="rail-pill-unread-dot" />}
      {muted && (
        <span className="rail-pill-muted-badge" title="Заглушён">
          <BellOff size={10} />
        </span>
      )}
    </button>
  )
}

export default function ServerRail({
  servers,
  activeId,
  onSelect,
  onCreate,
  onDiscover,
  onHome,
  homeNotificationCount,
  unreadServerIds,
  mutedServerIds,
  onContextMenu,
}: {
  servers: Server[]
  activeId: number | null
  onSelect: (s: Server) => void
  onCreate: () => void
  onDiscover: () => void
  /** Клик по «домику» — личные сообщения/друзья вместо сервера. */
  onHome: () => void
  /** Входящие заявки в друзья + диалоги с непрочитанными — общий счётчик
   * поверх домашней пилюли (см. AppShell). */
  homeNotificationCount: number
  /** Сервера, где есть непрочитанный текстовый канал (см. AppShell
   * computeNotice) — белая точка на пилюле, как в Discord. */
  unreadServerIds: Set<number>
  /** Сервера, заглушённые прямо сейчас (учитывает истечение muted_until) —
   * приглушённый значок колокольчика поверх пилюли. */
  mutedServerIds: Set<number>
  /** Правый клик по пилюле сервера — контекстное меню (см. AppShell). */
  onContextMenu: (s: Server, e: ReactMouseEvent) => void
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
        {homeNotificationCount > 0 && (
          <span className="rail-pill-badge">
            {homeNotificationCount > 99 ? '99+' : homeNotificationCount}
          </span>
        )}
      </button>
      <div className="rail-divider" />

      {servers.map((s) => (
        <RailServerPill
          key={s.id}
          server={s}
          active={activeId === s.id}
          unread={unreadServerIds.has(s.id)}
          muted={mutedServerIds.has(s.id)}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onHint={showHint}
          onHideHint={hideHint}
        />
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
