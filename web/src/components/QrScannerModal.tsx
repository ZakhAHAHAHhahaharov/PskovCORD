import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { CameraOff, ChevronLeft, Loader2 } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import { parseQrLoginText } from '../qrToken'
import QrConfirmCard from './QrConfirmCard'

type Phase = 'starting' | 'scanning' | 'denied' | 'unavailable'

/**
 * Встроенный в приложение сканер QR-входа (кнопка «Сканировать QR» в
 * настройках, см. SettingsModal) — тот же флоу, что и переход по ссылке
 * системной камерой (QrLoginConfirm), но без выхода из сайта: getUserMedia
 * + покадровое декодирование jsQR по холсту, снятому с видео.
 */
export default function QrScannerModal({
  onClose,
  isMobile,
}: {
  onClose: () => void
  /** Следующий полноэкранный "шаг" настроек на мобилке (см.
   * .settings-sub-overlay/UsernameChangeModal/PasswordChangeModal) — та же
   * стрелка назад в заголовке вместо кнопки "Отмена" снизу. */
  isMobile?: boolean
}) {
  useEscToClose(onClose)

  const [phase, setPhase] = useState<Phase>('starting')
  const [token, setToken] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const foundRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    canvasRef.current = document.createElement('canvas')

    const tick = () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || foundRef.current) return
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const result = jsQR(frame.data, frame.width, frame.height)
          if (result) {
            const found = parseQrLoginText(result.data)
            // Случайный QR-код в кадре, не имеющий отношения ко входу —
            // просто игнорируем и продолжаем сканировать, а не пугаем
            // ошибкой из-за чужого QR, случайно попавшего в объектив.
            if (found) {
              foundRef.current = true
              setToken(found)
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setPhase('scanning')
        rafRef.current = requestAnimationFrame(tick)
      } catch (err) {
        if (cancelled) return
        setPhase((err as DOMException).name === 'NotAllowedError' ? 'denied' : 'unavailable')
      }
    })()

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="modal-overlay settings-sub-overlay" onClick={onClose}>
      <div
        className={`modal qr-scanner-modal ${token ? '' : 'qr-scanner-modal-camera'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {token ? (
          <QrConfirmCard token={token} onClose={onClose} />
        ) : (
          <>
            {/* На мобилке (см. .qr-scanner-modal-camera) заголовок и подсказка
                лежат ПОВЕРХ видео с камеры (полупрозрачный градиент для
                читаемости), а не в отдельной серой шапке над ним — камера
                занимает экран от края до края. */}
            <h2 className="modal-title">
              {isMobile && (
                <button className="chat-back-btn" title="Назад" onClick={onClose}>
                  <ChevronLeft size={20} />
                </button>
              )}
              Сканировать QR-код входа
            </h2>
            <p className="login-sub">Наведите камеру на QR-код на экране входа</p>

            <div className="qr-scanner-viewport">
              <video ref={videoRef} className="qr-scanner-video" playsInline muted />
              {phase === 'starting' && (
                <div className="qr-scanner-overlay">
                  <Loader2 size={28} className="spin" />
                </div>
              )}
              {(phase === 'denied' || phase === 'unavailable') && (
                <div className="qr-scanner-overlay">
                  <CameraOff size={28} />
                  <p>
                    {phase === 'denied'
                      ? 'Нет доступа к камере. Разрешите доступ в настройках браузера.'
                      : 'Не удалось получить доступ к камере.'}
                  </p>
                </div>
              )}
              {phase === 'scanning' && <div className="qr-scanner-frame" />}
            </div>

            {/* На мобилке эта кнопка дублирует стрелку назад в заголовке. */}
            {!isMobile && (
              <button className="modal-close" onClick={onClose}>
                Отмена
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
