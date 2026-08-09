import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { api, Message } from '../api'
import { displayNameOf } from '../nicknames'
import { STICKER_TOKEN_RE } from '../emoji'
import Avatar from './Avatar'

/** Сколько ждать после последнего нажатия клавиши, прежде чем спрашивать
 * сервер. Поиск идёт по подстроке (см. backend ChannelMessageSearch), запрос
 * дешёвый — но слать его на каждую букву всё равно незачем. */
const DEBOUNCE_MS = 300

/** Минимум, который примет бэкенд (MIN_SEARCH_QUERY). Дублируется здесь не
 * ради валидации — она всё равно на сервере, — а чтобы не отправлять заведомо
 * отказной запрос и не мигать ошибкой на первой же букве. */
const MIN_QUERY = 2

/**
 * Поиск по сообщениям ветки — занимает место ленты, а не наслаивается на неё:
 * в 420px колонке всплывающая панель накрыла бы ровно то, ради чего её
 * открыли (см. ThreadPanel).
 *
 * Результат — плоский список «кто, что, когда» с переходом к сообщению в
 * ленте. Подсветки совпадения внутри текста нет намеренно: строка и так
 * короткая, а разметка поверх пользовательского текста потребовала бы
 * разбирать его наравне с markdown и упоминаниями.
 */
export default function ThreadSearch({
  channelId,
  onClose,
  onPick,
}: {
  channelId: number
  onClose: () => void
  onPick: (messageId: number) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Счётчик запросов — от гонки: ответ на старый запрос, доехавший позже
  // нового, не должен подменить свежую выдачу (тот же приём, что и
  // loadTokenRef в useChannelMessages).
  const tokenRef = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY) {
      setResults(null)
      setError('')
      setLoading(false)
      return
    }
    setLoading(true)
    const token = ++tokenRef.current
    const timer = window.setTimeout(() => {
      void api.searchMessages(channelId, trimmed)
        .then((found) => {
          if (tokenRef.current !== token) return
          setResults(found)
          setError('')
        })
        .catch((e: Error) => {
          if (tokenRef.current !== token) return
          setResults(null)
          setError(e.message)
        })
        .finally(() => {
          if (tokenRef.current === token) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [channelId, query])

  return (
    <div className="thread-search">
      <div className="thread-search-head">
        <Search size={14} />
        <input
          className="thread-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по ветке"
          autoFocus
        />
        {loading && <Loader2 size={14} className="spin" />}
        <button
          type="button"
          className="thread-panel-action"
          title="Закрыть поиск"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div className="thread-search-results">
        {error && <div className="thread-search-empty">{error}</div>}
        {!error && query.trim().length < MIN_QUERY && (
          <div className="thread-search-empty">
            Введите хотя бы {MIN_QUERY} символа.
          </div>
        )}
        {!error && results !== null && results.length === 0 && (
          <div className="thread-search-empty">Ничего не нашлось.</div>
        )}
        {results?.map((m) => (
          <button
            key={m.id}
            type="button"
            className="thread-search-hit"
            onClick={() => onPick(m.id)}
          >
            <Avatar
              name={m.author.username}
              color={m.author.avatar_color}
              image={m.author.avatar_image}
              size={20}
              userId={m.author.id}
            />
            <span className="thread-search-hit-body">
              <span className="thread-search-hit-head">
                <span className="thread-search-hit-author">{displayNameOf(m.author)}</span>
                <span className="thread-search-hit-time">
                  {new Date(m.created_at).toLocaleString('ru-RU', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </span>
              <span className="thread-search-hit-text">
                {m.content.replace(STICKER_TOKEN_RE, '[стикер]') || 'вложение'}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
