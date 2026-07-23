import { useEffect, useState } from 'react'
import { api, DiscoverServer, Server } from '../api'

export default function DiscoverModal({
  onClose,
  onJoined,
}: {
  onClose: () => void
  onJoined: (s: Server) => void
}) {
  const [list, setList] = useState<DiscoverServer[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        setList(await api.discover())
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const join = async (id: number) => {
    const s = await api.joinServer(id)
    onJoined(s)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Найти сервер</h2>
        {loading ? (
          <div className="modal-empty">Загрузка…</div>
        ) : list.length === 0 ? (
          <div className="modal-empty">Серверов пока нет — создай первый!</div>
        ) : (
          <div className="discover-list">
            {list.map((s) => (
              <div key={s.id} className="discover-row">
                <div className="discover-info">
                  <span className="discover-name">{s.name}</span>
                  <span className="discover-count">{s.member_count} участн.</span>
                </div>
                {s.is_member ? (
                  <span className="discover-joined">Вы участник</span>
                ) : (
                  <button className="btn-small" onClick={() => join(s.id)}>
                    Вступить
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
