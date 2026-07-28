import { useEffect } from 'react'
import { AuthProvider, useAuth } from './auth'
import { GatewayProvider } from './gateway'
import { SettingsProvider } from './settings'
import { handleGlobalEscape } from './modalStack'
import { parseQrLoginToken } from './qrToken'
import LoginScreen from './components/LoginScreen'
import AppShell from './components/AppShell'
import QrLoginConfirm from './components/QrLoginConfirm'

function Inner() {
  const { user, loading } = useAuth()
  if (loading) return <div className="fullscreen-center">Загрузка…</div>
  const qrToken = parseQrLoginToken()
  if (qrToken) {
    // Не залогинен на этом телефоне — сначала обычный вход, а не редирект:
    // тот же путь остаётся в адресной строке, после успешного login()
    // сработает та же проверка и покажет экран подтверждения без повторного
    // сканирования.
    if (!user) return <LoginScreen />
    return <QrLoginConfirm token={qrToken} />
  }
  if (!user) return <LoginScreen />
  return (
    <GatewayProvider>
      <AppShell />
    </GatewayProvider>
  )
}

export default function App() {
  // Единственный на всё приложение обработчик Escape — см. modalStack.ts:
  // закрывает самый верхний открытый модал/попап, следующий Escape — тот,
  // что под ним.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleGlobalEscape()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <SettingsProvider>
      <AuthProvider>
        <Inner />
      </AuthProvider>
    </SettingsProvider>
  )
}
