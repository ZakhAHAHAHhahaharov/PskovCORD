import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import {
  api,
  setTokens,
  getToken,
  setSessionExpiredHandler,
  Me,
  UserStatus,
} from './api'
import { loadCachedMe, saveCachedMe, clearCachedMe } from './userCache'

interface AuthCtx {
  user: Me | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  /** Завершить вход уже готовой парой токенов — тот же финальный шаг, что и
   * у login()/register() (setTokens + подтянуть /api/auth/me), но токены
   * приходят не с пароля, а с подтверждённого QR-входа (см. LoginScreen). */
  loginWithTokens: (access: string, refresh: string) => Promise<void>
  logout: () => void
  /** Оптимистичное обновление своего статуса в локальном состоянии (сама
   * отправка/персист — через gateway.setStatus). */
  updateLocalStatus: (status: UserStatus) => void
  /** Применить обновлённый профиль (ник/аватар) сразу после успешного PATCH
   * /api/auth/me — не дожидаясь эха через gateway (profile_update). */
  updateLocalUser: (user: Me) => void
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  // Сессия окончательно истекла (обновить токен не удалось). Без этого
  // истёкший токен приводил к тому, что все экраны молча схлопывались в
  // пустоту — серверов нет, сообщений нет, друзей нет, — и ничто не
  // предлагало войти заново.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null)
      clearCachedMe()
    })
    return () => setSessionExpiredHandler(null)
  }, [])

  useEffect(() => {
    ;(async () => {
      if (getToken()) {
        // Мгновенно показать последний известный профиль (ник/аватар/баннер)
        // из кэша, не дожидаясь сети — см. userCache.ts. Ответ /api/auth/me
        // ниже всё равно приходит следом и остаётся источником истины.
        const cached = loadCachedMe()
        if (cached) setUser(cached)
        try {
          const fresh = await api.me()
          setUser(fresh)
          saveCachedMe(fresh)
        } catch {
          setTokens(null, null)
          clearCachedMe()
        }
      }
      setLoading(false)
    })()
  }, [])

  const login = async (username: string, password: string) => {
    // refresh раньше просто отбрасывался — из-за этого обновлять сессию было
    // нечем и она жила ровно столько же, сколько access-токен.
    const { access, refresh } = await api.login(username, password)
    setTokens(access, refresh)
    const fresh = await api.me()
    setUser(fresh)
    saveCachedMe(fresh)
  }

  const loginWithTokens = async (access: string, refresh: string) => {
    setTokens(access, refresh)
    const fresh = await api.me()
    setUser(fresh)
    saveCachedMe(fresh)
  }

  const register = async (username: string, password: string) => {
    const data = await api.register(username, password)
    setTokens(data.access, data.refresh)
    setUser(data.user)
    saveCachedMe(data.user)
  }

  const logout = () => {
    // Гасим и Django-сессию (см. LoginView) — иначе после выхода из
    // приложения /adminpskordpro/ остался бы залогинен тем же cookie ещё
    // до истечения сессии. Best-effort — локальный выход не ждёт сеть.
    void api.logout().catch(() => {})
    setTokens(null, null)
    setUser(null)
    clearCachedMe()
  }

  const updateLocalStatus = (status: UserStatus) => {
    setUser((u) => {
      const next = u ? { ...u, status } : u
      if (next) saveCachedMe(next)
      return next
    })
  }

  const updateLocalUser = (updated: Me) => {
    setUser(updated)
    saveCachedMe(updated)
  }

  return (
    <Ctx.Provider
      value={{
        user, loading, login, register, loginWithTokens, logout,
        updateLocalStatus, updateLocalUser,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}
