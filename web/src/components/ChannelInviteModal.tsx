import { useEffect, useState } from 'react'
import { Check, Copy, Link as LinkIcon, Send } from 'lucide-react'
import { api, Channel, KnownPerson, Server } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

/**
 * Модалка «Пригласить в голосовой чат» — правый клик по голосовому каналу
 * (см. ChannelContextMenu). Тот же паттерн, что ServerInviteModal, но оба
 * способа привязаны к КОНКРЕТНОМУ каналу: личное приглашение доставляется
 * той же карточкой server_invite в переписку (см. ServerInviteCard — там же
 * показывает название канала и на "Вступить" сразу подключает к нему), а
 * ссылка — своя, отдельная от общей ссылки сервера (?voiceInvite=<код>,
 * см. VoiceInviteJoinModal — открывает предпросмотр, а не вступает мгновенно).
 */
export default function ChannelInviteModal({
  server,
  channel,
  people,
  onClose,
}: {
  server: Server
  channel: Channel
  people: KnownPerson[]
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [sendingId, setSendingId] = useState<number | null>(null)
  const [sentIds, setSentIds] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')

  const [link, setLink] = useState<string | null>(null)
  const [linkLoading, setLinkLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { code } = await api.serverInviteLink(server.id, channel.id)
        if (!cancelled) setLink(`${location.origin}${location.pathname}?voiceInvite=${code}`)
      } catch {
        /* ссылку не показываем — личное приглашение всё ещё работает */
      } finally {
        if (!cancelled) setLinkLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [server.id, channel.id])

  const invite = async (person: KnownPerson) => {
    setError('')
    setSendingId(person.id)
    try {
      await api.inviteToServer(server.id, person.id, channel.id)
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
        <h2 className="modal-title">Пригласить в «{channel.name}»</h2>

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
          <LinkIcon size={13} /> Или отправь ссылку на канал
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
          У того, кто перейдёт по ссылке, сначала откроется окно с предпросмотром — вступление
          подтверждается отдельно, как при заходе на сервер.
        </p>

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
