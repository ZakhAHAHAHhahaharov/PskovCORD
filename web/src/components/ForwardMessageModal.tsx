import { useState } from 'react'
import { AlertTriangle, Hash, Send } from 'lucide-react'
import { Attachment, Conversation, Server } from '../api'
import { conversationDisplayName } from '../conversation'
import { EMOJI_TOKEN_RE, STICKER_TOKEN_RE } from '../emoji'
import { useEscToClose } from '../modalStack'
import { OutboxTarget } from '../outbox'
import Avatar from './Avatar'

/** Превью пересылаемого текста — тем же токенам, что и в самом сообщении, но
 * без картинок (это одна строка предпросмотра, а не полноценная лента):
 * стикер и кастомный эмодзи заменяются человекочитаемой подписью, а не
 * сырым "<sticker:42>"/"<:кот:7>". */
function previewText(content: string): string {
  return content
    .replace(STICKER_TOKEN_RE, '[стикер]')
    .replace(EMOJI_TOKEN_RE, (_m, _a, name) => `:${name}:`)
}

/**
 * «Переслать» — контекстное меню сообщения → модалка выбора получателей.
 *
 * Пересылается только ТЕКСТ (content) — вложения переслать физически нельзя:
 * бэкенд отдаёт загрузку в новое сообщение только автору и только пока она
 * ничья (см. backend chat/consumers.py _bind_attachments), а вложение
 * пересылаемого сообщения может принадлежать вообще другому человеку и уже
 * привязано к своему. Стикеры и кастомные эмодзи это ограничение не
 * задевает — они не Attachment, а токены прямо в тексте, и уезжают как
 * обычная часть content. Если у сообщения есть файлы, об этом честно
 * предупреждает баннер — тихо ронять их было бы хуже.
 *
 * Получатели — мультивыбор из диалогов/групп и текстовых каналов серверов,
 * где я состою; голосовые каналы в список не попадают, слать в них нечего.
 * Отдельное поле комментария уходит ВТОРЫМ сообщением следом за пересланным
 * в каждую выбранную цель — так на той стороне видно и то, что переслали, и
 * что к этому добавили, отдельными репликами, а не одной слипшейся.
 */
export default function ForwardMessageModal({
  content,
  attachments,
  servers,
  conversations,
  onForward,
  onClose,
}: {
  content: string
  attachments: Attachment[]
  servers: Server[]
  conversations: Conversation[]
  onForward: (targets: OutboxTarget[], comment: string) => void
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [comment, setComment] = useState('')

  const key = (t: OutboxTarget) => `${t.kind}:${t.id}`

  const toggle = (t: OutboxTarget) => {
    const k = key(t)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const textChannels = servers.flatMap((s) =>
    s.channels
      .filter((c) => c.kind === 'text')
      .map((c) => ({ server: s, channel: c })),
  )

  const handleSubmit = () => {
    const targets: OutboxTarget[] = []
    for (const c of conversations) {
      if (selected.has(key({ kind: 'conversation', id: c.id }))) {
        targets.push({ kind: 'conversation', id: c.id })
      }
    }
    for (const { channel } of textChannels) {
      if (selected.has(key({ kind: 'channel', id: channel.id }))) {
        targets.push({ kind: 'channel', id: channel.id })
      }
    }
    if (targets.length === 0) return
    onForward(targets, comment.trim())
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal forward-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Переслать сообщение</h2>

        {content && <div className="forward-preview">{previewText(content)}</div>}

        {attachments.length > 0 && (
          <div className="forward-attachments-warning">
            <AlertTriangle size={14} />
            {attachments.length === 1
              ? 'Вложение не будет переслано — только текст.'
              : 'Вложения не будут пересланы — только текст.'}
          </div>
        )}

        <div className="field-label">Кому переслать</div>
        <div className="forward-recipients">
          {conversations.length === 0 && textChannels.length === 0 && (
            <div className="home-empty">Пока некуда — нет ни диалогов, ни каналов.</div>
          )}

          {conversations.map((c) => {
            const target: OutboxTarget = { kind: 'conversation', id: c.id }
            const name = conversationDisplayName(c)
            return (
              <label key={key(target)} className="forward-recipient-row">
                <input
                  type="checkbox"
                  checked={selected.has(key(target))}
                  onChange={() => toggle(target)}
                />
                <Avatar
                  name={name}
                  color={c.participants[0]?.avatar_color ?? '#5865f2'}
                  image={c.kind === 'dm' ? c.participants[0]?.avatar_image : undefined}
                  size={24}
                />
                <span>{name}</span>
              </label>
            )
          })}

          {servers.map((s) => {
            const channels = textChannels.filter((tc) => tc.server.id === s.id)
            if (channels.length === 0) return null
            return (
              <div key={s.id} className="forward-server-group">
                <div className="forward-server-name">{s.name}</div>
                {channels.map(({ channel }) => {
                  const target: OutboxTarget = { kind: 'channel', id: channel.id }
                  return (
                    <label key={key(target)} className="forward-recipient-row">
                      <input
                        type="checkbox"
                        checked={selected.has(key(target))}
                        onChange={() => toggle(target)}
                      />
                      <Hash size={14} className="forward-channel-icon" />
                      <span>{channel.name}</span>
                    </label>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="forward-comment-row">
          <input
            className="field-input"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Добавить сообщение (необязательно)"
            maxLength={2000}
          />
          <button
            type="button"
            className="btn-primary forward-send-btn"
            onClick={handleSubmit}
            disabled={selected.size === 0}
            title="Переслать"
          >
            <Send size={15} />
          </button>
        </div>

        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}
