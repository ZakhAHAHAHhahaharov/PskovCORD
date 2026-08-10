import { useEffect, useMemo, useRef, useState } from 'react'
import { Hash, Loader2, MessagesSquare, Search, Users, X } from 'lucide-react'
import { api, Conversation, ConversationMessage, Message, Server } from '../api'
import { conversationDisplayName } from '../conversation'
import { displayNameOf } from '../nicknames'
import { STICKER_TOKEN_RE } from '../emoji'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

/** Как и в ThreadSearch — не долбим сервер на каждую букву. */
const DEBOUNCE_MS = 300
/** MIN_SEARCH_QUERY на бэкенде. */
const MIN_QUERY = 2

type Scope = 'everywhere' | 'server'

/**
 * Поиск сразу по всему, что человеку видно: каналы и ветки всех его серверов
 * плюс личка и группы. До него искать можно было только внутри одного
 * открытого канала (ThreadSearch), то есть вопрос «где-то я это писал, не
 * помню где» решался перебором каналов руками.
 *
 * Область поиска переключается: «Везде» ищет ещё и в личке, «На этом сервере»
 * сужает до текущего (и личку тогда не трогает вовсе — см. backend
 * GlobalMessageSearch).
 */
export default function GlobalSearchModal({
  servers,
  conversations,
  currentServerId,
  onClose,
  onPickChannelMessage,
  onPickConversationMessage,
  isMobile,
}: {
  servers: Server[]
  conversations: Conversation[]
  /** Сервер, открытый сейчас, — для области «На этом сервере». null на
   * домашнем экране: там сужать не до чего, и переключатель не показываем. */
  currentServerId: number | null
  onClose: () => void
  onPickChannelMessage: (serverId: number, channelId: number, messageId: number) => void
  onPickConversationMessage: (conversationId: number) => void
  isMobile: boolean
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('everywhere')
  const [channelHits, setChannelHits] = useState<Message[] | null>(null)
  const [dmHits, setDmHits] = useState<ConversationMessage[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // От гонки: ответ на старый запрос, доехавший позже нового, не должен
  // подменить свежую выдачу (тот же приём, что и в ThreadSearch).
  const tokenRef = useRef(0)

  useEscToClose(onClose)

  /** Канал и сервер по id канала — выдача несёт только id, а показать надо
   * «#канал · Сервер», и по клику знать, куда переключаться. */
  const channelIndex = useMemo(() => {
    const index = new Map<number, { channelName: string; server: Server }>()
    for (const server of servers) {
      for (const channel of server.channels) {
        index.set(channel.id, { channelName: channel.name, server })
      }
    }
    return index
  }, [servers])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY) {
      setChannelHits(null)
      setDmHits(null)
      setError('')
      setLoading(false)
      return
    }
    setLoading(true)
    const token = ++tokenRef.current
    const timer = window.setTimeout(() => {
      void api
        .searchEverywhere(trimmed, scope === 'server' ? currentServerId : null)
        .then((found) => {
          if (tokenRef.current !== token) return
          setChannelHits(found.channel_messages)
          setDmHits(found.conversation_messages)
          setError('')
        })
        .catch((e: Error) => {
          if (tokenRef.current !== token) return
          setChannelHits(null)
          setDmHits(null)
          setError(e.message)
        })
        .finally(() => {
          if (tokenRef.current === token) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, scope, currentServerId])

  const total = (channelHits?.length ?? 0) + (dmHits?.length ?? 0)
  const searched = channelHits !== null || dmHits !== null

  const preview = (content: string) =>
    content.replace(STICKER_TOKEN_RE, '[стикер]') || 'вложение'

  const when = (iso: string) =>
    new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal global-search-modal ${isMobile ? 'modal-mobile' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="global-search-head">
          <Search size={16} />
          <input
            className="global-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по сообщениям"
            autoFocus
          />
          {loading && <Loader2 size={16} className="spin" />}
          <button type="button" className="global-search-close" title="Закрыть" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {currentServerId != null && (
          <div className="global-search-scope">
            <button
              type="button"
              className={`global-search-scope-btn ${scope === 'everywhere' ? 'active' : ''}`}
              onClick={() => setScope('everywhere')}
            >
              Везде
            </button>
            <button
              type="button"
              className={`global-search-scope-btn ${scope === 'server' ? 'active' : ''}`}
              onClick={() => setScope('server')}
            >
              На этом сервере
            </button>
          </div>
        )}

        <div className="global-search-results">
          {error && <div className="global-search-empty">{error}</div>}
          {!error && query.trim().length < MIN_QUERY && (
            <div className="global-search-empty">
              Введите хотя бы {MIN_QUERY} символа.
            </div>
          )}
          {!error && searched && total === 0 && (
            <div className="global-search-empty">Ничего не нашлось.</div>
          )}

          {!!channelHits?.length && (
            <div className="global-search-group-title">Каналы</div>
          )}
          {channelHits?.map((m) => {
            const where = channelIndex.get(m.channel)
            return (
              <button
                key={`c-${m.id}`}
                type="button"
                className="global-search-hit"
                onClick={() => {
                  // Канал не нашёлся в списке серверов — сообщение есть, а
                  // вести некуда (сервер только что покинули в соседней
                  // вкладке). Молча ничего не делаем, а не падаем.
                  if (!where) return
                  onPickChannelMessage(where.server.id, m.channel, m.id)
                  onClose()
                }}
              >
                <Avatar
                  name={m.author.username}
                  color={m.author.avatar_color}
                  image={m.author.avatar_image}
                  size={22}
                  userId={m.author.id}
                />
                <span className="global-search-hit-body">
                  <span className="global-search-hit-head">
                    <span className="global-search-hit-author">{displayNameOf(m.author)}</span>
                    <span className="global-search-hit-where">
                      <Hash size={11} />
                      {where ? `${where.channelName} · ${where.server.name}` : 'недоступно'}
                    </span>
                    <span className="global-search-hit-time">{when(m.created_at)}</span>
                  </span>
                  <span className="global-search-hit-text">{preview(m.content)}</span>
                </span>
              </button>
            )
          })}

          {!!dmHits?.length && (
            <div className="global-search-group-title">Личные сообщения</div>
          )}
          {dmHits?.map((m) => {
            const conversation = conversations.find((c) => c.id === m.conversation)
            return (
              <button
                key={`d-${m.id}`}
                type="button"
                className="global-search-hit"
                onClick={() => {
                  onPickConversationMessage(m.conversation)
                  onClose()
                }}
              >
                <Avatar
                  name={m.author.username}
                  color={m.author.avatar_color}
                  image={m.author.avatar_image}
                  size={22}
                  userId={m.author.id}
                />
                <span className="global-search-hit-body">
                  <span className="global-search-hit-head">
                    <span className="global-search-hit-author">{displayNameOf(m.author)}</span>
                    <span className="global-search-hit-where">
                      {conversation && conversation.participants.length > 1 ? (
                        <Users size={11} />
                      ) : (
                        <MessagesSquare size={11} />
                      )}
                      {conversation ? conversationDisplayName(conversation) : 'диалог'}
                    </span>
                    <span className="global-search-hit-time">{when(m.created_at)}</span>
                  </span>
                  <span className="global-search-hit-text">{preview(m.content)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
