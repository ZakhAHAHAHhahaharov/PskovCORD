import { useEffect, useState } from 'react'
import { Check, Loader2, UserPlus } from 'lucide-react'
import { api, Channel, Member, User } from '../api'
import { useEscToClose } from '../modalStack'
import { displayNameOf } from '../nicknames'
import Avatar from './Avatar'

/**
 * Кто в ветке и кого туда добавить. Осмысленно только для приватной
 * (Channel.invite_only): в обычную человек заходит сам, и список её
 * участников — это просто «кто отметился», управлять им незачем.
 *
 * Кандидаты — ростер сервера за вычетом тех, кто уже внутри. Тех, кому не
 * виден родительский канал, бэкенд молча пропустит (иначе приватной веткой
 * протаскивали бы в закрытый разговор) — здесь мы их не отсеиваем: клиент не
 * знает чужих допусков к приватным каналам, и решать это должен сервер.
 */
export default function ThreadMembersModal({
  thread,
  roster,
  canAdd,
  onClose,
}: {
  thread: Channel
  /** Ростер сервера — из кого выбирать. */
  roster: Member[]
  /** Автор ветки или модератор: только им можно звать (см. backend
   * ThreadMembers.post). Остальные видят список, но без кнопки. */
  canAdd: boolean
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [members, setMembers] = useState<User[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api.threadMembers(thread.id)
      .then((list) => {
        if (alive) setMembers(list)
      })
      .catch((e: Error) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [thread.id])

  const memberIds = new Set((members ?? []).map((m) => m.id))
  const candidates = roster.filter((m) => !memberIds.has(m.id))

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleAdd = async () => {
    if (picked.size === 0 || saving) return
    setSaving(true)
    setError('')
    try {
      const added = await api.addThreadMembers(thread.id, [...picked])
      setMembers((prev) => [...(prev ?? []), ...added])
      setPicked(new Set())
      // Часть выбранных сервер мог не добавить — тех, кому не виден
      // родительский канал. Молчать об этом нельзя: человек нажал «добавить»
      // и вправе знать, что добавились не все.
      if (added.length < picked.size) {
        setError('Не всех удалось добавить: кому-то не виден сам канал.')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal thread-members-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Участники ветки «{thread.name}»</h2>

        {error && <div className="login-error">{error}</div>}
        {members === null && !error && (
          <div className="thread-list-empty">
            <Loader2 size={18} className="spin" /> Загружаем…
          </div>
        )}

        {members !== null && (
          <>
            <div className="field-label">Уже в ветке ({members.length})</div>
            <div className="thread-members-list">
              {members.map((m) => (
                <div key={m.id} className="thread-members-row">
                  <Avatar
                    name={m.username}
                    color={m.avatar_color}
                    image={m.avatar_image}
                    size={24}
                    userId={m.id}
                  />
                  <span className="thread-members-name">{displayNameOf(m)}</span>
                </div>
              ))}
            </div>

            {canAdd && candidates.length > 0 && (
              <>
                <div className="field-label">Добавить</div>
                <div className="thread-members-list">
                  {candidates.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`thread-members-row pick ${
                        picked.has(m.id) ? 'picked' : ''
                      }`}
                      onClick={() => toggle(m.id)}
                    >
                      <Avatar
                        name={m.username}
                        color={m.avatar_color}
                        image={m.avatar_image}
                        size={24}
                        userId={m.id}
                      />
                      <span className="thread-members-name">{displayNameOf(m)}</span>
                      {picked.has(m.id) && <Check size={15} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <div className="create-channel-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Закрыть
          </button>
          {canAdd && (
            <button
              type="button"
              className="btn-primary"
              disabled={picked.size === 0 || saving}
              onClick={() => void handleAdd()}
            >
              {saving
                ? <Loader2 size={15} className="spin" />
                : <><UserPlus size={15} /> Добавить ({picked.size})</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
