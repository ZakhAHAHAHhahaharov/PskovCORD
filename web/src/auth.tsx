import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api, setToken, getToken, User, UserStatus } from './api'

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => void
  /** Оптимистичное обновление своего статуса в локальном состоянии (сама
   * отправка/персист — через gateway.setStatus). */
  updateLocalStatus: (status: UserStatus) => void
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      if (getToken()) {
        try {
          setUser(await api.me())
        } catch {
          setToken(null)
        }
      }
      setLoading(false)
    })()
  }, [])

  const login = async (username: string, password: string) => {
    const { access } = await api.login(username, password)
    setToken(access)
    setUser(await api.me())
  }

  const register = async (username: string, password: string) => {
    const data = await api.register(username, password)
    setToken(data.access)
    setUser(data.user)
  }

  const logout = () => {
    // Гасим и Django-сессию (см. LoginView) — иначе после выхода из
    // приложения /adminpskordpro/ остался бы залогинен тем же cookie ещё
    // до истечения сессии. Best-effort — локальный выход не ждёт сеть.
    void api.logout().catch(() => {})
    setToken(null)
    setUser(null)
  }

  const updateLocalStatus = (status: UserStatus) => {
    setUser((u) => (u ? { ...u, status } : u))
  }

  return (
    <Ctx.Provider
      value={{ user, loading, login, register, logout, updateLocalStatus }}
    >
      {children}
    </Ctx.Provider>
  )
}
