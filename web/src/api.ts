/** Статус, который выбирает сам пользователь. */
export type UserStatus = 'online' | 'dnd' | 'invisible'
/** Что видят другие: invisible всегда маскируется под offline. */
export type EffectiveStatus = 'online' | 'dnd' | 'offline'

export interface User {
  id: number
  username: string
  avatar_color: string
  status: UserStatus
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

export interface MessageReply {
  id: number
  author: User
  content: string
}

export interface Message {
  id: number
  channel: number
  author: User
  content: string
  reply_to: MessageReply | null
  created_at: string
  edited_at: string | null
}

export interface Member extends Omit<User, 'status'> {
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
      detail = j.detail || j.username?.[0] || j.password?.[0] || JSON.stringify(j)
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
}
