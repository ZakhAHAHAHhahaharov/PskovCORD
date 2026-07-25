/** Статус, который выбирает сам пользователь. */
export type UserStatus = 'online' | 'dnd' | 'invisible'
/** Что видят другие: invisible всегда маскируется под offline. */
export type EffectiveStatus = 'online' | 'dnd' | 'offline'
/** Кто может НАЧАТЬ новую личку со мной — не действует на уже идущие диалоги. */
export type DmPrivacy = 'friends' | 'nobody' | 'everyone'

export interface User {
  id: number
  username: string
  avatar_color: string
  /** Картинка аватара (data-URL), пусто — цветной кружок с буквой. */
  avatar_image: string
  /** CSS linear-gradient() для фона карточки профиля; пусто — дефолтный градиент. */
  banner_gradient: string
  /** Гифка фона карточки профиля (data-URL); если задана — приоритетнее градиента. */
  banner_image: string
  status: UserStatus
  dm_privacy: DmPrivacy
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

export interface Server {
  id: number
  name: string
  owner: number
  created_at: string
  channels: Channel[]
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
  /** Статус микрофона/наушников — виден всем, даже не подключённым к каналу. */
  muted: boolean
  deafened: boolean
  /** Демонстрирует ли сейчас экран — тоже видно всем, не только в канале. */
  sharing_screen: boolean
}

export interface DiscoverServer {
  id: number
  name: string
  member_count: number
  is_member: boolean
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

export function setToken(t: string | null) {
  accessToken = t
  if (t) localStorage.setItem('access', t)
  else localStorage.removeItem('access')
}

export function getToken(): string | null {
  return accessToken
}

async function req(path: string, options: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  // include: логин/регистрация заодно ставят Django-сессию (см. LoginView) —
  // в деве Vite (:5173) и API (:8000) разные origin'ы, без явного include
  // браузер cookie не сохранит/не пришлёт.
  const res = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' })
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

export const api = {
  register: (username: string, password: string) =>
    req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string): Promise<{ access: string; refresh: string }> =>
    req('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  me: (): Promise<User> => req('/api/auth/me'),
  updateProfile: (data: {
    username?: string
    avatar_image?: string
    banner_gradient?: string
    banner_image?: string
    dm_privacy?: DmPrivacy
  }): Promise<User> => req('/api/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
  changePassword: (current_password: string, new_password: string) =>
    req('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
  config: () => req('/api/config'),

  servers: (): Promise<Server[]> => req('/api/servers'),
  createServer: (name: string): Promise<Server> =>
    req('/api/servers', { method: 'POST', body: JSON.stringify({ name }) }),
  discover: (): Promise<DiscoverServer[]> => req('/api/servers/discover'),
  joinServer: (id: number): Promise<Server> =>
    req(`/api/servers/${id}/join`, { method: 'POST' }),
  members: (serverId: number): Promise<Member[]> =>
    req(`/api/servers/${serverId}/members`),
  createChannel: (serverId: number, name: string, kind: string): Promise<Channel> =>
    req(`/api/servers/${serverId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name, kind }),
    }),

  messages: (channelId: number): Promise<Message[]> =>
    req(`/api/channels/${channelId}/messages`),
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
  conversationMessages: (conversationId: number): Promise<ConversationMessage[]> =>
    req(`/api/conversations/${conversationId}/messages`),
  conversationVoiceCredentials: (
    conversationId: number,
  ): Promise<{ sfu_url: string; sfu_token: string; ttl: number }> =>
    req(`/api/conversations/${conversationId}/voice-credentials`, { method: 'POST' }),
}
