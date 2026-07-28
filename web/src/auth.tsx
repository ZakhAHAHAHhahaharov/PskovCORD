import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import {
  api,
  setTokens,
  getToken,
  getRefreshToken,
  setSessionExpiredHandler,
  Me,
  UserStatus,
} from './api'
import { loadCachedMe, saveCachedMe, clearCachedMe } from './userCache'
import {
  StoredAccount,
  MAX_ACCOUNTS,
  loadKnownAccounts,
  upsertKnownAccount,
  removeKnownAccount,
} from './accounts'

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
  /** Другие аккаунты, уже авторизованные на этом устройстве (см. accounts.ts),
   * без активного — тот всегда в user выше. */
  knownAccounts: StoredAccount[]
  /** Войти ещё одним аккаунтом (до MAX_ACCOUNTS суммарно), не разлогинивая
   * текущий — он уходит в knownAccounts, новый становится активным. */
  addAccount: (username: string, password: string) => Promise<void>
  /** Переключиться на один из knownAccounts — текущий активный уходит в
   * knownAccounts (со своим текущим refresh), целевой становится активным. */
  switchAccount: (accountId: number) => Promise<void>
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [knownAccounts, setKnownAccounts] = useState<StoredAccount[]>(loadKnownAccounts)

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

  const addAccount = async (username: string, password: string) => {
    if (!user) throw new Error('Нет активного аккаунта.')
    if (knownAccounts.length >= MAX_ACCOUNTS - 1) {
      throw new Error(`Можно авторизовать не более ${MAX_ACCOUNTS} аккаунтов одновременно.`)
    }
    // Сначала логин новым аккаунтом — неверный пароль не должен трогать
    // текущую сессию.
    const { access, refresh } = await api.login(username, password)
    const outgoingRefresh = getRefreshToken()
    if (outgoingRefresh) {
      setKnownAccounts((prev) =>
        upsertKnownAccount(
          {
            id: user.id,
            username: user.username,
            avatar_color: user.avatar_color,
            avatar_image: user.avatar_image,
            status: user.status,
            refresh: outgoingRefresh,
          },
          prev,
        ),
      )
    }
    setTokens(access, refresh)
    const fresh = await api.me()
    setUser(fresh)
    saveCachedMe(fresh)
  }

  const switchAccount = async (accountId: number) => {
    const target = knownAccounts.find((a) => a.id === accountId)
    if (!target) throw new Error('Аккаунт не найден.')
    let result: { access: string; refresh: string; user: Me }
    try {
      result = await api.switchAccount(target.refresh)
    } catch (err) {
      // Сохранённый refresh протух/отозван — слот больше не рабочий, вычищаем
      // его, чтобы не предлагать снова с тем же результатом.
      setKnownAccounts((prev) => removeKnownAccount(accountId, prev))
      throw err
    }
    const outgoingRefresh = getRefreshToken()
    setKnownAccounts((prev) => {
      const withOutgoing =
        user && outgoingRefresh
          ? upsertKnownAccount(
              {
                id: user.id,
                username: user.username,
                avatar_color: user.avatar_color,
                avatar_image: user.avatar_image,
                status: user.status,
                refresh: outgoingRefresh,
              },
              prev,
            )
          : prev
      return removeKnownAccount(accountId, withOutgoing)
    })
    // setTokens ДО setUser, одним тактом без await между ними — при remount
    // GatewayProvider (см. key={user.id} в App.tsx) должен увидеть уже новый
    // токен на самом первом connect().
    setTokens(result.access, result.refresh)
    setUser(result.user)
    saveCachedMe(result.user)
  }

  return (
    <Ctx.Provider
      value={{
        user, loading, login, register, loginWithTokens, logout,
        updateLocalStatus, updateLocalUser,
        knownAccounts, addAccount, switchAccount,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}
