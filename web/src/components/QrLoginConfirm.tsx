import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { describeUserAgent } from '../deviceInfo'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

type Phase = 'loading' | 'ready' | 'confirming' | 'done' | 'error'

/**
 * Экран на ТЕЛЕФОНЕ после сканирования QR с экрана логина ПК (см.
 * App.tsx — рендерится вместо обычного приложения по пути /qr-login/:token,
 * когда пользователь на этом устройстве уже залогинен). Сканирование само
 * по себе НЕ логинит ПК — сначала человек должен своими глазами сверить код,
 * который видит на ПК, с тем, что выбирает здесь (см. backend
 * accounts.models.QRLoginRequest — это страховка от релея QR на фишинг-
 * странице, не защита от перебора самого token'а).
 */
export default function QrLoginConfirm({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [candidates, setCandidates] = useState<string[]>([])
  const [device, setDevice] = useState<{ ip_address: string | null; user_agent: string } | null>(
    null,
  )
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api.qrScan(token)
        if (cancelled) return
        setCandidates(data.candidates)
        setDevice(data.device)
        setPhase('ready')
      } catch (err) {
        if (cancelled) return
        setError((err as Error).message)
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const choose = async (code: string) => {
    setPhase('confirming')
    setError('')
    try {
      await api.qrConfirm(token, code)
      setPhase('done')
    } catch (err) {
      setError((err as Error).message)
      setPhase('error')
    }
  }

  return (
    <div className="login-bg">
      <div className="login-card qr-confirm-card">
        <h1 className="login-logo">{APP_NAME}</h1>

        {phase === 'loading' && <p className="login-sub">Проверяем код…</p>}

        {phase === 'error' && (
          <>
            <p className="login-error qr-confirm-error">{error}</p>
            <p className="login-sub">
              Похоже, этот QR-код устарел или уже использован. Обновите его на экране входа и
              отсканируйте заново.
            </p>
          </>
        )}

        {(phase === 'ready' || phase === 'confirming') && device && (
          <>
            <div className="qr-confirm-device">
              <ShieldCheck size={18} />
              <div>
                <div className="qr-confirm-device-title">
                  Вход в аккаунт на устройстве: {describeUserAgent(device.user_agent)}
                </div>
                <div className="qr-confirm-device-ip">IP: {device.ip_address ?? 'неизвестен'}</div>
              </div>
            </div>
            <p className="login-sub qr-confirm-question">
              Это вы? Выберите код, который видите на экране входа
            </p>
            <div className="qr-confirm-codes">
              {candidates.map((c) => (
                <button
                  key={c}
                  className="qr-confirm-code-btn"
                  onClick={() => choose(c)}
                  disabled={phase === 'confirming'}
                >
                  {phase === 'confirming' ? <Loader2 size={18} className="spin" /> : c}
                </button>
              ))}
            </div>
          </>
        )}

        {phase === 'done' && (
          <p className="profile-success qr-confirm-done">
            Готово! Компьютер сейчас войдёт в аккаунт — эту вкладку можно закрыть.
          </p>
        )}
      </div>
    </div>
  )
}
