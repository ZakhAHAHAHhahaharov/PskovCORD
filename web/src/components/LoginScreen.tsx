import { useState } from 'react'
import { useAuth } from '../auth'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

export default function LoginScreen() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'register' && password !== confirmPassword) {
      setError('Пароли не совпадают')
      return
    }
    setBusy(true)
    try {
      if (mode === 'login') await login(username.trim(), password)
      else await register(username.trim(), password)
    } catch (err) {
      setError((err as Error).message || 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-bg">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-logo">{APP_NAME}</h1>
        <p className="login-sub">
          {mode === 'login' ? 'С возвращением!' : 'Создай аккаунт'}
        </p>

        <label className="field-label">Имя пользователя</label>
        <input
          className="field-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          required
        />

        <label className="field-label">Пароль</label>
        <input
          className="field-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {mode === 'register' && (
          <>
            <label className="field-label">Повтори пароль</label>
            <input
              className="field-input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </>
        )}

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
        </button>

        <div className="login-switch">
          {mode === 'login' ? 'Нужен аккаунт? ' : 'Уже есть аккаунт? '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setConfirmPassword('')
              setError(null)
            }}
          >
            {mode === 'login' ? 'Зарегистрироваться' : 'Войти'}
          </button>
        </div>
      </form>
    </div>
  )
}
