import { AuthProvider, useAuth } from './auth'
import { GatewayProvider } from './gateway'
import { SettingsProvider } from './settings'
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
  return (
    <SettingsProvider>
      <AuthProvider>
        <Inner />
      </AuthProvider>
    </SettingsProvider>
  )
}
