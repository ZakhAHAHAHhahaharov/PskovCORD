import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Loader2 } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'
const POLL_INTERVAL_MS = 1500

type PanelState = 'loading' | 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error'

/**
 * Блок справа от формы логина (см. LoginScreen) — вход по QR, как в
 * WhatsApp/Telegram Web. Заводит запрос (api.qrStart), рисует QR на
 * /qr-login/:token и поллит статус. "Отсканировано" (с телефона, см.
 * QrLoginConfirm) — ПК показывает свой 2-значный код поверх QR, человек на
 * телефоне выбирает тот же код из вариантов; "подтверждено" — ПК получает
 * готовые токены и логинится тем же путём, что и обычный логин/регистрация
 * (см. auth.loginWithTokens).
 */
export default function QrLoginPanel() {
  const { loginWithTokens } = useAuth()
  const [state, setState] = useState<PanelState>('loading')
  const [qrImage, setQrImage] = useState('')
  const [code, setCode] = useState('')

  const tokenRef = useRef<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)

  const poll = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = setTimeout(async () => {
      if (cancelledRef.current || !tokenRef.current) return
      try {
        const data = await api.qrStatus(tokenRef.current)
        if (cancelledRef.current) return
        if (data.status === 'pending') {
          poll()
        } else if (data.status === 'scanned') {
          setState('scanned')
          setCode(data.code ?? '')
          poll()
        } else if (data.status === 'confirmed' && data.access && data.refresh) {
          setState('confirmed')
          await loginWithTokens(data.access, data.refresh)
        } else if (data.status === 'denied') {
          setState('error')
        } else {
          setState('expired')
        }
      } catch {
        // Сетевой сбой одного поллинга — не сдаёмся, пробуем ещё раз тем же
        // интервалом, а не молча оставляем панель висеть навсегда.
        if (!cancelledRef.current) poll()
      }
    }, POLL_INTERVAL_MS)
  }

  const start = async () => {
    setState('loading')
    setCode('')
    try {
      const { token } = await api.qrStart()
      if (cancelledRef.current) return
      tokenRef.current = token
      const url = `${window.location.origin}/qr-login/${token}`
      const image = await QRCode.toDataURL(url, { width: 208, margin: 1 })
      if (cancelledRef.current) return
      setQrImage(image)
      setState('pending')
      poll()
    } catch {
      if (!cancelledRef.current) setState('error')
    }
  }

  useEffect(() => {
    cancelledRef.current = false
    void start()
    return () => {
      cancelledRef.current = true
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="qr-login-panel">
      <h2 className="qr-login-title">Войти с помощью QR-кода</h2>
      <p className="qr-login-subtitle">
        Отсканируйте код с помощью мобильного приложения {APP_NAME}, чтобы сразу же войти в
        систему
      </p>

      <div className="qr-login-code-box">
        {state === 'loading' && <Loader2 size={28} className="spin" />}

        {(state === 'pending' || state === 'scanned' || state === 'confirmed') && qrImage && (
          <img src={qrImage} alt="QR-код для входа" className="qr-login-image" />
        )}

        {state === 'scanned' && (
          <div className="qr-login-scanned-overlay">
            <p>Выберите этот код на телефоне</p>
            <div className="qr-login-pin">{code}</div>
          </div>
        )}

        {state === 'confirmed' && (
          <div className="qr-login-scanned-overlay">
            <Loader2 size={24} className="spin" />
          </div>
        )}

        {(state === 'expired' || state === 'error') && (
          <div className="qr-login-expired">
            <p>{state === 'expired' ? 'Код истёк' : 'Не удалось подтвердить вход'}</p>
            <button type="button" className="link" onClick={() => void start()}>
              Обновить код
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
