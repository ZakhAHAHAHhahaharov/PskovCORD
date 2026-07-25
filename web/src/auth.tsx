import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api, setToken, getToken, User, UserStatus } from './api'
import { loadCachedUser, saveCachedUser, clearCachedUser } from './userCache'

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => void
  /** Оптимистичное обновление своего статуса в локальном состоянии (сама
   * отправка/персист — через gateway.setStatus). */
  updateLocalStatus: (status: UserStatus) => void
  /** Применить обновлённый профиль (ник/аватар) сразу после успешного PATCH
   * /api/auth/me — не дожидаясь эха через gateway (profile_update). */
  updateLocalUser: (user: User) => void
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      if (getToken()) {
        // Мгновенно показать последний известный профиль (ник/аватар/баннер)
        // из кэша, не дожидаясь сети — см. userCache.ts. Ответ /api/auth/me
        // ниже всё равно приходит следом и остаётся источником истины.
        const cached = loadCachedUser()
        if (cached) setUser(cached)
        try {
          const fresh = await api.me()
          setUser(fresh)
          saveCachedUser(fresh)
        } catch {
          setToken(null)
          clearCachedUser()
        }
      }
      setLoading(false)
    })()
  }, [])

  const login = async (username: string, password: string) => {
    const { access } = await api.login(username, password)
    setToken(access)
    const fresh = await api.me()
    setUser(fresh)
    saveCachedUser(fresh)
  }

  const register = async (username: string, password: string) => {
    const data = await api.register(username, password)
    setToken(data.access)
    setUser(data.user)
    saveCachedUser(data.user)
  }

  const logout = () => {
    // Гасим и Django-сессию (см. LoginView) — иначе после выхода из
    // приложения /adminpskordpro/ остался бы залогинен тем же cookie ещё
    // до истечения сессии. Best-effort — локальный выход не ждёт сеть.
    void api.logout().catch(() => {})
    setToken(null)
    setUser(null)
    clearCachedUser()
  }

  const updateLocalStatus = (status: UserStatus) => {
    setUser((u) => {
      const next = u ? { ...u, status } : u
      if (next) saveCachedUser(next)
      return next
    })
  }

  const updateLocalUser = (updated: User) => {
    setUser(updated)
    saveCachedUser(updated)
  }

  return (
    <Ctx.Provider
      value={{ user, loading, login, register, logout, updateLocalStatus, updateLocalUser }}
    >
      {children}
    </Ctx.Provider>
  )
}
