import { Check, X } from 'lucide-react'
import { NotificationLevel, Server } from '../api'
import { useEscToClose } from '../modalStack'

const NOTIFICATION_LEVELS: { value: NotificationLevel; label: string; hint: string }[] = [
  { value: 'all', label: 'Все сообщения', hint: 'Уведомлять о каждом новом сообщении' },
  {
    value: 'mentions',
    label: 'Только @упоминания',
    hint: 'Уведомлять, только когда упомянули меня или мою роль',
  },
  { value: 'none', label: 'Ничего', hint: 'Не уведомлять об этом сервере вовсе' },
]

/**
 * Параметры уведомлений сервера — правый клик по пилюле в ServerRail →
 * «Параметры уведомлений». Вынесено из подменю-флаута контекстного меню в
 * отдельное модальное окно (см. ServerMuteModal — та же причина).
 */
export default function ServerNotificationsModal({
  server,
  onClose,
  onNotificationLevel,
  onToggleIgnoreAtHere,
  onToggleSuppressRoleMentions,
}: {
  server: Server
  onClose: () => void
  onNotificationLevel: (level: NotificationLevel) => void
  onToggleIgnoreAtHere: (value: boolean) => void
  onToggleSuppressRoleMentions: (value: boolean) => void
}) {
  useEscToClose(onClose)
  const settings = server.my_settings

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal server-option-modal" onClick={(e) => e.stopPropagation()}>
        <button className="privacy-modal-close" title="Закрыть" onClick={onClose}>
          <X size={18} />
        </button>
        <h2 className="modal-title">
          Параметры уведомлений
          <br />
          <span className="privacy-modal-server">— {server.name}</span>
        </h2>

        <div className="server-option-list">
          {NOTIFICATION_LEVELS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`server-option-item server-option-level ${
                settings.notification_level === o.value ? 'active' : ''
              }`}
              onClick={() => onNotificationLevel(o.value)}
            >
              <span className="server-option-level-head">
                {o.label}
                {settings.notification_level === o.value && <Check size={15} />}
              </span>
              <span className="server-option-level-hint">{o.hint}</span>
            </button>
          ))}
        </div>

        <div className="server-option-list server-option-list-checks">
          <label className="server-option-checkbox">
            <input
              type="checkbox"
              checked={settings.ignore_at_here}
              onChange={(e) => onToggleIgnoreAtHere(e.target.checked)}
            />
            Игнорировать @all и @here
          </label>
          <label className="server-option-checkbox">
            <input
              type="checkbox"
              checked={settings.suppress_role_mentions}
              onChange={(e) => onToggleSuppressRoleMentions(e.target.checked)}
            />
            Отключить все @упоминания ролей
          </label>
        </div>

        <button className="btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </div>
  )
}
