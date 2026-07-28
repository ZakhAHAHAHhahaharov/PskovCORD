import QrConfirmCard from './QrConfirmCard'

/**
 * Страница на ТЕЛЕФОНЕ после сканирования QR системной камерой (см.
 * App.tsx — рендерится вместо обычного приложения по пути /qr-login/:token,
 * когда пользователь на этом устройстве уже залогинен). Собственно UI
 * подтверждения — см. QrConfirmCard, тот же компонент используется и
 * встроенным сканером в настройках (QrScannerModal).
 */
export default function QrLoginConfirm({ token }: { token: string }) {
  return (
    <div className="login-bg">
      <div className="login-card qr-confirm-card">
        <QrConfirmCard token={token} />
      </div>
    </div>
  )
}
