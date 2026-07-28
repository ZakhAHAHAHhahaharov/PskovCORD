import { useState } from 'react'
import { useAuth } from '../auth'
import { useEscToClose } from '../modalStack'
import PasswordInput from './PasswordInput'

/** Вход ещё одним аккаунтом без выхода из текущего (Блок 4 в StatusMenu) —
 * только логин, регистрация нового аккаунта отсюда не нужна (для неё уже
 * есть LoginScreen на самом первом входе). */
export default function AddAccountModal({ onClose }: { onClose: () => void }) {
  useEscToClose(onClose)
  const { addAccount } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await addAccount(username.trim(), password)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Добавить аккаунт</h2>

        <form onSubmit={submit}>
          <div className="field-label">Имя пользователя</div>
          <input
            className="field-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />

          <div className="field-label">Пароль</div>
          <PasswordInput
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {error && <div className="login-error">{error}</div>}

          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? '…' : 'Войти'}
          </button>
        </form>

        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}
