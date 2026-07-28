import { useEffect, useState } from 'react'
import { api, DiscoverServer, Server } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

export default function DiscoverModal({
  onClose,
  onJoined,
}: {
  onClose: () => void
  onJoined: (s: Server) => void
}) {
  useEscToClose(onClose)
  const [list, setList] = useState<DiscoverServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  // Запрос уходит на сервер (а не фильтруется на месте) — иначе поиск видел
  // бы только первую страницу выдачи. Дебаунс, чтобы не слать запрос на
  // каждую букву.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const result = await api.discover(query)
            // Ответ на УЖЕ неактуальный запрос игнорируем: ответы могут
            // прийти не в том порядке, в каком уходили, и медленный ответ по
            // старому запросу перетёр бы свежий.
            if (!cancelled) setList(result)
          } catch (e) {
            if (!cancelled) setError((e as Error).message)
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
      },
      query ? 250 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const join = async (id: number) => {
    setError('')
    try {
      const result = await api.joinServer(id)
      // Сервер «по заявке» членства сразу не даёт — только ставит заявку в
      // очередь на одобрение (см. chat.views.ServerJoin).
      if ('status' in result && result.status === 'pending') {
        setList((prev) =>
          prev.map((s) => (s.id === id ? { ...s, request_pending: true } : s)),
        )
        return
      }
      onJoined(result as Server)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Найти сервер</h2>
        <input
          className="discover-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Название или особенность сервера"
          autoFocus
        />
        {error && <div className="login-error">{error}</div>}
        {loading ? (
          <div className="modal-empty">Загрузка…</div>
        ) : list.length === 0 ? (
          <div className="modal-empty">
            {query
              ? 'Ничего не нашлось. Приватные сервера в поиске не показываются — в них можно попасть, только зная о них.'
              : 'Серверов пока нет — создай первый!'}
          </div>
        ) : (
          <div className="discover-list">
            {list.map((s) => (
              <div key={s.id} className="discover-row">
                <Avatar name={s.name} color="#5865f2" image={s.icon} size={36} />
                <div className="discover-info">
                  <span className="discover-name">
                    {s.name}
                    {s.age_restricted && <span className="discover-flag">18+</span>}
                    {s.is_private && <span className="discover-flag">приватный</span>}
                  </span>
                  <span className="discover-count">
                    {s.member_count} участн.
                    {s.tags.length > 0 && ` · ${s.tags.join(' · ')}`}
                  </span>
                  {s.description && <span className="srv-hint">{s.description}</span>}
                </div>
                {s.is_member ? (
                  <span className="discover-joined">Вы участник</span>
                ) : s.request_pending ? (
                  <span className="discover-joined">Заявка отправлена</span>
                ) : s.access_mode === 'invite' ? (
                  <span className="discover-joined">По приглашению</span>
                ) : (
                  <button className="btn-small" onClick={() => join(s.id)}>
                    {s.access_mode === 'request' ? 'Подать заявку' : 'Вступить'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
