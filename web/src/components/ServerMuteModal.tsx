import { BellRing, X } from 'lucide-react'
import { Server } from '../api'
import { useEscToClose } from '../modalStack'

const MUTE_OPTIONS: { label: string; minutes: number }[] = [
  { label: '15 минут', minutes: 15 },
  { label: '30 минут', minutes: 30 },
  { label: '1 час', minutes: 60 },
  { label: '3 часа', minutes: 180 },
  { label: '8 часов', minutes: 480 },
  { label: '24 часа', minutes: 1440 },
]

/** «Заглушено до 14 марта, 18:42» — muted_until приезжает ISO-строкой. */
function formatUntil(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Заглушение сервера — правый клик по пилюле в ServerRail → «Заглушить
 * сервер». Раньше это было подменю-флаут внутри самого контекстного меню;
 * список из семи вариантов не помещался в попап и заводил в нём полосы
 * прокрутки, поэтому вынесено в отдельное модальное окно.
 */
export default function ServerMuteModal({
  server,
  onClose,
  onMute,
  onUnmute,
}: {
  server: Server
  onClose: () => void
  onMute: (minutes: number | 'forever') => void
  onUnmute: () => void
}) {
  useEscToClose(onClose)
  const settings = server.my_settings
  const until = formatUntil(settings.muted_until)

  const pick = (minutes: number | 'forever') => {
    onMute(minutes)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal server-option-modal" onClick={(e) => e.stopPropagation()}>
        <button className="privacy-modal-close" title="Закрыть" onClick={onClose}>
          <X size={18} />
        </button>
        <h2 className="modal-title">
          Заглушить сервер
          <br />
          <span className="privacy-modal-server">— {server.name}</span>
        </h2>

        <p className="server-option-hint">
          {settings.muted
            ? settings.muted_forever
              ? 'Сейчас сервер заглушён до тех пор, пока вы не включите уведомления.'
              : until
                ? `Сейчас сервер заглушён до ${until}.`
                : 'Сейчас сервер заглушён.'
            : 'Пока сервер заглушён, вы не получаете уведомления о его сообщениях.'}
        </p>

        {settings.muted && (
          <button
            type="button"
            className="server-option-item server-option-unmute"
            onClick={() => {
              onUnmute()
              onClose()
            }}
          >
            <BellRing size={15} /> Включить уведомления
          </button>
        )}

        <div className="server-option-list">
          {/* Две колонки — семь пунктов в столбик растягивали модалку так,
              что на невысоком окне она упиралась в края экрана. */}
          <div className="server-option-grid">
            {MUTE_OPTIONS.map((o) => (
              <button
                key={o.minutes}
                type="button"
                className="server-option-item"
                onClick={() => pick(o.minutes)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`server-option-item ${settings.muted_forever ? 'active' : ''}`}
            onClick={() => pick('forever')}
          >
            До тех пор, пока не включу
          </button>
        </div>

        <button className="btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </div>
  )
}
