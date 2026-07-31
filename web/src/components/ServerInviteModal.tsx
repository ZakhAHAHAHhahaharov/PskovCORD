import { useEffect, useState } from 'react'
import { Check, Copy, Link as LinkIcon, Send } from 'lucide-react'
import { api, KnownPerson, Server } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'
import { pluralPeople } from './ServerSettingsModal'

/**
 * Модалка «Пригласить на сервер» — правый клик по пилюле сервера.
 *
 * Два независимых способа, оба обходят access_mode сервера целиком (см.
 * backend chat.models.ServerInvite):
 *   - личное приглашение конкретному человеку — придёт карточкой сервера
 *     прямо в переписку с ним (см. ServerInviteCard/MessageList);
 *   - постоянная многоразовая ссылка — СВОЯ у каждого участника (см.
 *     backend ServerInviteLink), можно скопировать и отправить куда угодно,
 *     даже мимо этого приложения. Сколько людей уже вступило именно по ней —
 *     видно тут же, а модераторам весь список сразу — в ServerSettingsModal
 *     (вкладка «Доступ»).
 */
export default function ServerInviteModal({
  server,
  people,
  onClose,
}: {
  server: Server
  people: KnownPerson[]
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [sendingId, setSendingId] = useState<number | null>(null)
  const [sentIds, setSentIds] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')

  const [link, setLink] = useState<string | null>(null)
  const [uses, setUses] = useState<number | null>(null)
  const [linkLoading, setLinkLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { code, uses: usesCount } = await api.serverInviteLink(server.id)
        if (!cancelled) {
          setLink(`${location.origin}${location.pathname}?invite=${code}`)
          setUses(usesCount)
        }
      } catch {
        /* ссылку не показываем — личное приглашение всё ещё работает */
      } finally {
        if (!cancelled) setLinkLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [server.id])

  const invite = async (person: KnownPerson) => {
    setError('')
    setSendingId(person.id)
    try {
      await api.inviteToServer(server.id, person.id)
      setSentIds((prev) => new Set(prev).add(person.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSendingId(null)
    }
  }

  const copyLink = () => {
    if (!link) return
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Пригласить на «{server.name}»</h2>

        <div className="field-label">Отправить другу напрямую</div>
        <div className="new-conversation-list invite-people-list">
          {people.length === 0 && (
            <div className="home-empty">Пока некого приглашать — сначала добавь друзей.</div>
          )}
          {people.map((p) => {
            const sent = sentIds.has(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className="new-conversation-row invite-person-row"
                disabled={sent || sendingId === p.id}
                onClick={() => invite(p)}
              >
                <Avatar
                  name={p.username}
                  color={p.avatar_color}
                  image={p.avatar_image}
                  size={28}
                  userId={p.id}
                  showStatus
                />
                <span className="member-name">{p.username}</span>
                <span className="invite-person-action">
                  {sent ? (
                    <>
                      <Check size={14} /> Отправлено
                    </>
                  ) : (
                    <Send size={14} />
                  )}
                </span>
              </button>
            )
          })}
        </div>

        {error && <div className="login-error">{error}</div>}

        <div className="field-label invite-link-label">
          <LinkIcon size={13} /> Или отправь ссылку
        </div>
        <div className="invite-link-row">
          <input
            className="field-input"
            readOnly
            value={linkLoading ? 'Создаём ссылку…' : link ?? 'Ссылку получить не удалось'}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="btn-small"
            disabled={!link}
            onClick={copyLink}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <p className="srv-hint">
          Ссылка многоразовая, только твоя и работает даже для сервера «только по приглашению» —
          обладание ей и есть приглашение.
          {uses != null && ` Приглашено: ${uses} ${pluralPeople(uses)}.`}
        </p>

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
