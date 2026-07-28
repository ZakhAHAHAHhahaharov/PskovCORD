/** Статус, который выбирает сам пользователь. */
export type UserStatus = 'online' | 'dnd' | 'invisible'
/** Что видят другие: invisible всегда маскируется под offline. */
export type EffectiveStatus = 'online' | 'dnd' | 'offline'
/** Кто может НАЧАТЬ новую личку со мной — не действует на уже идущие диалоги. */
export type DmPrivacy = 'friends' | 'nobody' | 'everyone'

/** Публичный профиль — то, что приходит про ДРУГИХ людей.
 *
 * Тяжёлой гифки-баннера здесь намеренно нет: этот объект вложен в каждое
 * сообщение и в каждую строку ростера, и баннер (до 4 МБ data-URL'ом) уезжал
 * десятки раз за один ответ. Для чужой карточки профиля он догружается
 * отдельно по требованию — api.profileCard(). */
export interface User {
  id: number
  username: string
  avatar_color: string
  /** Картинка аватара (data-URL), пусто — цветной кружок с буквой. */
  avatar_image: string
  /** CSS linear-gradient() для фона карточки профиля; пусто — дефолтный градиент. */
  banner_gradient: string
  status: UserStatus
}

/** Свой профиль (/api/auth/me) — всё, включая личные настройки и баннер. */
export interface Me extends User {
  /** Гифка фона карточки профиля (data-URL); если задана — приоритетнее градиента. */
  banner_image: string
  dm_privacy: DmPrivacy
}

/** Тяжёлая часть чужого профиля — грузится, когда открыли карточку. */
export interface ProfileCard {
  id: number
  banner_gradient: string
  banner_image: string
}

/** Один активный сеанс (устройство/браузер) — «Активные сеансы» в
 * настройках, см. backend accounts.models.LoginSession. */
export interface Session {
  id: number
  ip_address: string | null
  user_agent: string
  created_at: string
  last_seen_at: string
  /** Тот самый сеанс, чьим токеном сейчас авторизован этот клиент. */
  is_current: boolean
}

/** Вход по QR — см. backend accounts.models.QRLoginRequest. */
export type QRStatus = 'pending' | 'scanned' | 'confirmed' | 'denied' | 'expired'

export interface QRStatusResponse {
  status: QRStatus
  /** Есть только при status='scanned' — тот самый код, что нужно выбрать на телефоне. */
  code?: string
  /** Есть только при status='confirmed', и только один раз — сервер тут же
   * забывает запрос (см. accounts.views.QRStatusView). */
  access?: string
  refresh?: string
  user?: Me
}

export interface QRScanResponse {
  candidates: string[]
  device: { ip_address: string | null; user_agent: string }
}

export interface Channel {
  id: number
  server: number
  name: string
  kind: 'text' | 'voice'
  position: number
  /** Момент начала текущего разговора (unix-секунды), null если пусто. Только voice. */
  call_started_at: number | null
  /** Статус звонка, который видят все; null если пусто. Только voice. */
  topic: string | null
}

/** Права роли на сервере — 1:1 с булевыми полями chat.models.Role
 * (список и порядок для UI — chat/roles.py PERMISSION_FIELDS). */
// manage_invites / manage_nicknames / mention_everyone отсюда убраны: они
// охраняли фичи, которых в проекте нет (модели Invite, никнеймов на сервере
// и разбора @all/@online/@here не существует), и были переключателями,
// которые не делали ничего. Колонки в БД остались — вернутся сюда вместе с
// самими фичами (см. chat/roles.py RESERVED_PERMISSION_FIELDS).
export type ServerPermission =
  | 'view_channels'
  | 'manage_channels'
  | 'manage_roles'
  | 'manage_server'
  | 'manage_members'
  | 'send_messages'
  | 'delete_messages'
  | 'speak'
  | 'video'

export type ServerPermissions = Record<ServerPermission, boolean>

export interface Role extends ServerPermissions {
  id: number
  name: string
  color: string
  position: number
  /** Роль «для всех» (аналог @everyone) — её нельзя удалить и не нужно выдавать. */
  is_default: boolean
}

/** Как попасть на сервер — вкладка «Доступ» редактора. */
export type ServerAccessMode = 'invite' | 'request' | 'public'

export interface ServerRule {
  title: string
  text: string
}

export interface Server {
  id: number
  name: string
  owner: number
  created_at: string
  channels: Channel[]
  /** Значок сервера (data-URL, до 512×512); пусто — инициалы в ServerRail. */
  icon: string
  banner_gradient: string
  banner_image: string
  description: string
  /** «Особенности» — короткие теги для поиска серверов и подсказки. */
  tags: string[]
  /** Приватный: описание/особенности видят только участники. */
  is_private: boolean
  access_mode: ServerAccessMode
  age_restricted: boolean
  rules: ServerRule[]
  /** Мои права на этом сервере — по ним прячутся кнопки редактора. */
  my_permissions: ServerPermissions
  member_count: number
}

export interface ServerJoinRequestEntry {
  id: number
  user: User
  message: string
  created_at: string
}

export interface ServerBanEntry {
  id: number
  user: User
  banned_by: User | null
  reason: string
  created_at: string
}

export interface ChatMessageReplyBase {
  id: number
  author: User
  content: string
}

/** Общая форма сообщения — и серверного (Message), и личного/группового
 * (ConversationMessage). MessageList/MessageInput работают только с этими
 * полями и не знают, откуда сообщение (см. web/src/components/MessageList.tsx,
 * MessageInput.tsx) — общий базовый тип позволяет переиспользовать оба
 * компонента для диалогов без дублирования. */
export interface ChatMessageBase {
  id: number
  author: User
  content: string
  reply_to: ChatMessageReplyBase | null
  created_at: string
  edited_at: string | null
}

export interface Message extends ChatMessageBase {
  channel: number
}

export interface Member extends Omit<User, 'status' | 'dm_privacy'> {
  online: boolean
  voice_channel: string | null
  status: EffectiveStatus
  /** Персонально выданные роли (без роли по умолчанию — она у всех). */
  role_ids: number[]
  is_owner: boolean
  /** Статус микрофона/наушников — виден всем, даже не подключённым к каналу. */
  muted: boolean
  deafened: boolean
  /** Демонстрирует ли сейчас экран — тоже видно всем, не только в канале. */
  sharing_screen: boolean
}

export interface DiscoverServer {
  id: number
  name: string
  icon: string
  member_count: number
  is_member: boolean
  /** У приватного сервера description/tags приходят пустыми, пока не вступишь. */
  is_private: boolean
  access_mode: ServerAccessMode
  age_restricted: boolean
  /** Заявка на вступление уже отправлена и ждёт одобрения. */
  request_pending: boolean
  description: string
  tags: string[]
}

export interface FriendRequestEntry {
  id: number
  user: User
}

export interface FriendsState {
  friends: User[]
  incoming: FriendRequestEntry[]
  outgoing: FriendRequestEntry[]
}

/** Человек для пикера «новый диалог/группа» — друзья + те, с кем есть общий сервер. */
export interface KnownPerson extends User {
  is_friend: boolean
}

export type ConversationKind = 'dm' | 'group'

export interface ConversationLastMessage {
  content: string
  author_id: number
  created_at: string
}

export interface Conversation {
  id: number
  kind: ConversationKind
  /** Только для group; пусто — фронт сам собирает заголовок из участников. */
  name: string
  created_at: string
  /** Без меня самого. */
  participants: User[]
  last_message: ConversationLastMessage | null
  call_started_at: number | null
}

export interface ConversationMessage extends ChatMessageBase {
  conversation: number
}

// Пусто => same-origin (относительные запросы). Для dev задаётся в web/.env.
const API: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

let accessToken: string | null = localStorage.getItem('access')
// Раньше refresh-токен приходил с логина и молча выбрасывался: механизма
// обновления сессии не существовало вовсе, так что время жизни сессии было
// равно времени жизни access-токена, а по его истечении все запросы начинали
// падать без единого объяснения.
let refreshToken: string | null = localStorage.getItem('refresh')

export function setTokens(access: string | null, refresh: string | null) {
  accessToken = access
  if (access) localStorage.setItem('access', access)
  else localStorage.removeItem('access')
  refreshToken = refresh
  if (refresh) localStorage.setItem('refresh', refresh)
  else localStorage.removeItem('refresh')
}

export function getToken(): string | null {
  return accessToken
}

export function getRefreshToken(): string | null {
  return refreshToken
}

/** Колбэк «сессия окончательно умерла» — ставит auth.tsx, чтобы разлогинить
 * UI. Без него истёкший токен приводил к тому, что все экраны молча
 * схлопывались в пустое состояние: серверов нет, сообщений нет, друзей нет,
 * а причина не показана нигде. */
let onSessionExpired: (() => void) | null = null

export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn
}

// Один общий промис на все параллельные 401. Иначе десяток одновременных
// запросов запустил бы десяток refresh'ей, а с ротацией токенов на сервере
// (SIMPLE_JWT.ROTATE_REFRESH_TOKENS) выжил бы ровно один — остальные
// получили бы отказ и выкинули пользователя на логин без причины.
let refreshInFlight: Promise<string | null> | null = null

function refreshAccessToken(): Promise<string | null> {
  if (!refreshToken) return Promise.resolve(null)
  if (!refreshInFlight) {
    // Захватываем токен, с которым стартовали: если за время фетча кто-то
    // переключил аккаунт (см. auth.tsx switchAccount) или вышел, module-level
    // refreshToken уже указывает на другой аккаунт/пуст — применять к нему
    // результат ЭТОГО, более старого, обновления нельзя, иначе токены только
    // что переключённого аккаунта тихо затрутся токенами предыдущего.
    const startedWith = refreshToken
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API}/api/auth/token/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refresh: startedWith }),
        })
        if (!res.ok) return null
        const data = await res.json()
        if (refreshToken !== startedWith) return null
        // ROTATE_REFRESH_TOKENS=True — сервер отдаёт заодно новый refresh, а
        // старый отправляет в блэклист. Не сохранить его = разлогиниться на
        // следующем же обновлении.
        setTokens(data.access, data.refresh ?? startedWith)
        return data.access as string
      } catch {
        return null
      } finally {
        refreshInFlight = null
      }
    })()
  }
  return refreshInFlight
}

async function req(path: string, options: RequestInit = {}, allowRetry = true): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  // include: логин/регистрация заодно ставят Django-сессию (см. LoginView) —
  // в деве Vite (:5173) и API (:8000) разные origin'ы, без явного include
  // браузер cookie не сохранит/не пришлёт.
  const res = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' })

  // 401 больше не сваливается в общую кучу ошибок: сначала пробуем обновить
  // токен и повторить запрос ровно один раз, и только если это не вышло —
  // честно сообщаем, что сессия кончилась.
  if (res.status === 401 && allowRetry && accessToken) {
    const fresh = await refreshAccessToken()
    if (fresh) return req(path, options, false)
    setTokens(null, null)
    onSessionExpired?.()
    throw new Error('Сессия истекла — войдите заново.')
  }

  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = await res.json()
      // DRF отдаёт либо {"detail": "..."}, либо по-полевые ошибки валидации
      // {"поле": ["сообщение", ...], ...} — независимо от имени поля берём
      // первое сообщение первого поля, не полагаясь на конкретные названия
      // (username/password/current_password/avatar_image/...).
      const firstFieldError = Object.values(j).find(
        (v): v is string[] => Array.isArray(v) && typeof v[0] === 'string',
      )?.[0]
      detail = j.detail || firstFieldError || JSON.stringify(j)
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  if (res.status === 204) return null
  return res.json()
}

function buildQuery(params: Record<string, number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${v}`).join('&')
}

export const api = {
  register: (username: string, password: string) =>
    req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string): Promise<{ access: string; refresh: string }> =>
    // allowRetry=false: 401 здесь означает «неверный логин/пароль», а вовсе
    // не протухший токен — обновлять нечего, и попытка refresh'а только
    // подменила бы понятную ошибку на «сессия истекла».
    req(
      '/api/auth/token',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      false,
    ),
  // refresh отдаём серверу, чтобы он положил его в блэклист — иначе «выход»
  // не отзывал ничего и токен жил ещё неделю.
  logout: () =>
    req('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh: getRefreshToken() }),
    }),
  me: (): Promise<Me> => req('/api/auth/me'),
  updateProfile: (data: {
    username?: string
    /** Обязателен, если меняется username — см. backend
     * ProfileUpdateSerializer.validate. */
    current_password?: string
    avatar_image?: string
    banner_gradient?: string
    banner_image?: string
    dm_privacy?: DmPrivacy
  }): Promise<Me> => req('/api/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
  profileCard: (userId: number): Promise<ProfileCard> =>
    req(`/api/users/${userId}/profile-card`),
  changePassword: (current_password: string, new_password: string) =>
    req('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
  /** Переключиться на другой аккаунт, уже авторизованный на этом устройстве
   * (см. accounts.ts) — принимает ЕГО refresh, получает свежую JWT-пару и
   * профиль; сервер заодно переставляет Django-сессию (см. backend
   * SwitchAccountView). */
  switchAccount: (refresh: string): Promise<{ access: string; refresh: string; user: Me }> =>
    req('/api/auth/switch', { method: 'POST', body: JSON.stringify({ refresh }) }),
  getSessions: (): Promise<Session[]> => req('/api/auth/sessions'),
  /** Отозвать ОДИН чужой сеанс — крестик у "других устройств" в настройках.
   * Текущий сеанс так не отозвать (сервер отдаст 400 — для него есть
   * обычный выход). */
  revokeSession: (id: number) => req(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  /** «Выйти на всех известных устройствах» — не меняет пароль, только
   * отзывает refresh-токены всех сеансов, включая текущий. */
  revokeAllSessions: () => req('/api/auth/sessions/revoke-all', { method: 'POST' }),

  // --- вход по QR-коду -----------------------------------------------------
  /** Экран логина на ПК — без авторизации, ПК ещё не залогинен. */
  qrStart: (): Promise<{ token: string; expires_in: number }> =>
    req('/api/auth/qr/start', { method: 'POST' }),
  /** Поллинг с ПК тем же token'ом — тоже без авторизации. */
  qrStatus: (token: string): Promise<QRStatusResponse> => req(`/api/auth/qr/${token}/status`),
  /** Телефон (уже залогинен) сканирует QR. */
  qrScan: (token: string): Promise<QRScanResponse> =>
    req(`/api/auth/qr/${token}/scan`, { method: 'POST' }),
  /** Телефон подтверждает код, который видит на экране ПК. */
  qrConfirm: (token: string, code: string) =>
    req(`/api/auth/qr/${token}/confirm`, { method: 'POST', body: JSON.stringify({ code }) }),

  config: () => req('/api/config'),

  servers: (): Promise<Server[]> => req('/api/servers'),
  createServer: (name: string): Promise<Server> =>
    req('/api/servers', { method: 'POST', body: JSON.stringify({ name }) }),
  discover: (): Promise<DiscoverServer[]> => req('/api/servers/discover'),
  /** Сервер «по заявке» вместо вступления отдаёт {status:'pending'} —
   * членства ещё нет, ждём одобрения (см. chat.views.ServerJoin). */
  joinServer: (id: number): Promise<Server | { status: 'pending'; detail: string }> =>
    req(`/api/servers/${id}/join`, { method: 'POST' }),
  members: (serverId: number): Promise<Member[]> =>
    req(`/api/servers/${serverId}/members`),

  // --- редактор сервера ---------------------------------------------------
  updateServer: (
    id: number,
    data: Partial<{
      name: string
      icon: string
      banner_gradient: string
      banner_image: string
      description: string
      tags: string[]
      is_private: boolean
      access_mode: ServerAccessMode
      age_restricted: boolean
      rules: ServerRule[]
    }>,
  ): Promise<Server> =>
    req(`/api/servers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  roles: (serverId: number): Promise<Role[]> => req(`/api/servers/${serverId}/roles`),
  createRole: (serverId: number, data: Partial<Role>): Promise<Role> =>
    req(`/api/servers/${serverId}/roles`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateRole: (serverId: number, roleId: number, data: Partial<Role>): Promise<Role> =>
    req(`/api/servers/${serverId}/roles/${roleId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteRole: (serverId: number, roleId: number) =>
    req(`/api/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' }),
  setMemberRoles: (serverId: number, userId: number, roleIds: number[]) =>
    req(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role_ids: roleIds }),
    }),
  kickMember: (serverId: number, userId: number) =>
    req(`/api/servers/${serverId}/members/${userId}`, { method: 'DELETE' }),

  serverJoinRequests: (serverId: number): Promise<ServerJoinRequestEntry[]> =>
    req(`/api/servers/${serverId}/requests`),
  approveJoinRequest: (serverId: number, requestId: number) =>
    req(`/api/servers/${serverId}/requests/${requestId}`, { method: 'POST' }),
  declineJoinRequest: (serverId: number, requestId: number) =>
    req(`/api/servers/${serverId}/requests/${requestId}`, { method: 'DELETE' }),

  serverBans: (serverId: number): Promise<ServerBanEntry[]> =>
    req(`/api/servers/${serverId}/bans`),
  banMember: (serverId: number, userId: number, reason = ''): Promise<ServerBanEntry> =>
    req(`/api/servers/${serverId}/bans`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, reason }),
    }),
  unbanMember: (serverId: number, userId: number) =>
    req(`/api/servers/${serverId}/bans/${userId}`, { method: 'DELETE' }),
  createChannel: (serverId: number, name: string, kind: string): Promise<Channel> =>
    req(`/api/servers/${serverId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name, kind }),
    }),

  /** before — страница старше указанного сообщения (скролл вверх),
   *  after — то, что появилось после (добор пропущенного, когда WS лежал). */
  messages: (
    channelId: number,
    opts: { before?: number; after?: number; limit?: number } = {},
  ): Promise<Message[]> =>
    req(`/api/channels/${channelId}/messages${buildQuery(opts)}`),
  voiceCredentials: (
    channelId: number,
  ): Promise<{ sfu_url: string; sfu_token: string; ttl: number }> =>
    req(`/api/channels/${channelId}/voice-credentials`, { method: 'POST' }),

  friends: (): Promise<FriendsState> => req('/api/friends'),
  sendFriendRequest: (
    target: { userId: number } | { username: string },
  ): Promise<{ id: number; status: string }> =>
    req('/api/friends/requests', {
      method: 'POST',
      body: JSON.stringify(
        'userId' in target ? { user_id: target.userId } : { username: target.username },
      ),
    }),
  acceptFriendRequest: (requestId: number): Promise<{ id: number; status: string }> =>
    req(`/api/friends/requests/${requestId}/accept`, { method: 'POST' }),
  declineFriendRequest: (requestId: number) =>
    req(`/api/friends/requests/${requestId}`, { method: 'DELETE' }),
  removeFriend: (userId: number) =>
    req(`/api/friends/${userId}`, { method: 'DELETE' }),

  knownPeople: (): Promise<KnownPerson[]> => req('/api/people/known'),

  conversations: (): Promise<Conversation[]> => req('/api/conversations'),
  createConversation: (data: {
    kind: ConversationKind
    user_ids: number[]
    name?: string
  }): Promise<Conversation> =>
    req('/api/conversations', { method: 'POST', body: JSON.stringify(data) }),
  conversationMessages: (
    conversationId: number,
    opts: { before?: number; after?: number; limit?: number } = {},
  ): Promise<ConversationMessage[]> =>
    req(`/api/conversations/${conversationId}/messages${buildQuery(opts)}`),
  /** Выйти из беседы. Раньше выхода не существовало вовсе — из группы,
   *  в которую тебя добавили, деться было некуда. */
  leaveConversation: (conversationId: number) =>
    req(`/api/conversations/${conversationId}`, { method: 'DELETE' }),
  conversationVoiceCredentials: (
    conversationId: number,
  ): Promise<{ sfu_url: string; sfu_token: string; ttl: number }> =>
    req(`/api/conversations/${conversationId}/voice-credentials`, { method: 'POST' }),
}
