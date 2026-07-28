import { useState } from 'react'
import { X } from 'lucide-react'
import { api, Server } from '../api'
import { useEscToClose } from '../modalStack'

function PrivacySwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={`privacy-switch ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="privacy-switch-track" />
    </label>
  )
}

/**
 * Настройки приватности ОДНОГО сервера — правый клик по пилюле в ServerRail
 * → «Настройки конфиденциальности». Пока ровно один рабочий переключатель
 * (allow_dms_from_server, см. backend chat.permissions.can_dm) — остальные
 * пункты с макета намеренно не добавлены: под "Запросы общения"/
 * "Публиковать активность"/"Присоединение к активности" в проекте нет ни
 * фильтра сообщений от незнакомцев, ни статуса активности игр/приложений —
 * показывать переключатель без единого эффекта хуже, чем не показывать его
 * вовсе (пока сама фича не появится).
 */
export default function ServerPrivacyModal({
  server,
  onClose,
  onSettingsUpdated,
}: {
  server: Server
  onClose: () => void
  onSettingsUpdated: (serverId: number, patch: Partial<Server['my_settings']>) => void
}) {
  useEscToClose(onClose)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const toggleAllowDms = async (value: boolean) => {
    setError('')
    setSaving(true)
    // Оптимистично — переключатель отзывается сразу, откатываем при ошибке.
    onSettingsUpdated(server.id, { allow_dms_from_server: value })
    try {
      await api.updateServerSettings(server.id, { allow_dms_from_server: value })
    } catch (e) {
      onSettingsUpdated(server.id, { allow_dms_from_server: !value })
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal privacy-modal" onClick={(e) => e.stopPropagation()}>
        <button className="privacy-modal-close" title="Закрыть" onClick={onClose}>
          <X size={18} />
        </button>
        <h2 className="modal-title">
          Настройки конфиденциальности
          <br />
          <span className="privacy-modal-server">— {server.name}</span>
        </h2>

        <div className="privacy-row">
          <div className="privacy-row-text">
            <span className="privacy-row-label">Личные сообщения</span>
            <span className="privacy-row-hint">
              Разрешить ЛС от других участников этого сервера
            </span>
          </div>
          <PrivacySwitch
            checked={server.my_settings.allow_dms_from_server}
            disabled={saving}
            onChange={toggleAllowDms}
          />
        </div>

        {error && <div className="login-error">{error}</div>}

        <p className="privacy-modal-note">Новые настройки будут добавляться в будущем ^_^</p>

        <button className="btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </div>
  )
}
