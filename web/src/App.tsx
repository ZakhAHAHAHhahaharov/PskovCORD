import { useEffect } from 'react'
import { AuthProvider, useAuth } from './auth'
import { GatewayProvider } from './gateway'
import { SettingsProvider } from './settings'
import { handleGlobalEscape } from './modalStack'
import LoginScreen from './components/LoginScreen'
import AppShell from './components/AppShell'

function Inner() {
  const { user, loading } = useAuth()
  if (loading) return <div className="fullscreen-center">Загрузка…</div>
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
