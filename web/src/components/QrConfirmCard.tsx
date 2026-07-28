import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { describeUserAgent } from '../deviceInfo'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

type Phase = 'loading' | 'ready' | 'confirming' | 'done' | 'error'

/**
 * Общая часть экрана подтверждения QR-входа — показывает устройство/IP/
 * браузер десктопа и даёт выбрать совпадающий 2-значный код. Используется
 * и на отдельной странице /qr-login/:token (см. QrLoginConfirm — открывается
 * системной камерой телефона), и во встроенном сканере в настройках (см.
 * QrScannerModal — тот же токен, но получен через getUserMedia/jsQR, без
 * перехода по ссылке).
 */
export default function QrConfirmCard({
  token,
  onClose,
}: {
  token: string
  /** Если передан — рендерится в модалке (есть кнопка «Закрыть» на done),
   * иначе это отдельная страница («эту вкладку можно закрыть»). */
  onClose?: () => void
}) {
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
    <>
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
        <>
          <p className="profile-success qr-confirm-done">
            {onClose
              ? 'Готово! Компьютер сейчас войдёт в аккаунт.'
              : 'Готово! Компьютер сейчас войдёт в аккаунт — эту вкладку можно закрыть.'}
          </p>
          {onClose && (
            <button type="button" className="btn-primary" onClick={onClose}>
              Закрыть
            </button>
          )}
        </>
      )}
    </>
  )
}
