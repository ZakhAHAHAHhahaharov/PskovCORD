import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import {
  api,
  ApiError,
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
        } catch (err) {
          // Токены выбрасываем ТОЛЬКО если сервер сам отверг их (401/403).
          // Раньше сюда попадала любая ошибка — в том числе «сервер не
          // ответил»: открыть приложение в момент перезапуска бэкенда,
          // деплоя или короткого обрыва связи означало молча лишиться
          // сессии и получить экран входа. Это и была самая частая причина
          // «иногда выбивает с акка» (см. ApiError в api.ts).
          const status = err instanceof ApiError ? err.status : 0
          if (status === 401 || status === 403) {
            setTokens(null, null)
            clearCachedMe()
            setUser(null)
          }
          // Иначе — остаёмся с кэшированным профилем (или на экране входа,
          // если кэша нет), но токены сохраняем: следующий запрос/реконнект
          // подхватит живую сессию сам.
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
    // Тот же самый аккаунт добавить нельзя. Без этой проверки логин под уже
    // активным аккаунтом клал его КОПИЮ в knownAccounts (текущий уезжает
    // туда, новый — с тем же id — становится активным), и в переключателе
    // он показывался дважды. Ник уникален регистронезависимо (см. backend
    // RegisterSerializer.validate_username), так что сравнения ников хватает,
    // чтобы вообще не ходить в сеть; настоящая же защита — по id ниже, ник
    // могли и сменить с тех пор, как запись попала в knownAccounts.
    const wanted = username.trim().toLowerCase()
    if (user.username.toLowerCase() === wanted) {
      throw new Error('Вы уже вошли в этот аккаунт.')
    }
    if (knownAccounts.some((a) => a.username.toLowerCase() === wanted)) {
      throw new Error('Этот аккаунт уже добавлен — переключитесь на него.')
    }
    // Сначала логин новым аккаунтом — неверный пароль не должен трогать
    // текущую сессию.
    const { access, refresh } = await api.login(username, password)
    const outgoing = user
    const outgoingAccess = getToken()
    const outgoingRefresh = getRefreshToken()
    setTokens(access, refresh)
    let fresh: Me
    try {
      fresh = await api.me()
    } catch (err) {
      // Новые токены оказались нерабочими — возвращаем прежнюю сессию как
      // была, иначе неудачное добавление выкинуло бы и из текущего аккаунта.
      setTokens(outgoingAccess, outgoingRefresh)
      throw err
    }
    if (fresh.id === outgoing.id) {
      // Тот же аккаунт под другим ником (переименовали) — второй слот ему не
      // заводим, просто остаёмся в нём же со свежими токенами.
      setKnownAccounts((prev) => removeKnownAccount(fresh.id, prev))
      setUser(fresh)
      saveCachedMe(fresh)
      throw new Error('Вы уже вошли в этот аккаунт.')
    }
    if (outgoingRefresh) {
      setKnownAccounts((prev) =>
        upsertKnownAccount(
          {
            id: outgoing.id,
            username: outgoing.username,
            avatar_color: outgoing.avatar_color,
            avatar_image: outgoing.avatar_image,
            status: outgoing.status,
            refresh: outgoingRefresh,
          },
          // Целевой аккаунт становится активным — его прежняя «свёрнутая»
          // запись (если он уже был в списке под старым ником) обязана уйти,
          // иначе он окажется и активным, и в списке одновременно.
          removeKnownAccount(fresh.id, prev),
        ),
      )
    } else {
      setKnownAccounts((prev) => removeKnownAccount(fresh.id, prev))
    }
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
        // user.id === result.user.id значит, что «другой» аккаунт на самом
        // деле тот же самый (испорченное хранилище прошлых версий, см.
        // accounts.dedupeById) — записывать себя же в список нельзя, иначе
        // дубль воспроизводится снова.
        user && outgoingRefresh && user.id !== result.user.id
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
      // И по слоту, на который нажали, и по id того, кем в итоге стали:
      // обычно это одно и то же, но если запись в списке устарела, второй
      // вызов не даст активному аккаунту остаться ещё и в переключателе.
      return removeKnownAccount(
        result.user.id,
        removeKnownAccount(accountId, withOutgoing),
      )
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
