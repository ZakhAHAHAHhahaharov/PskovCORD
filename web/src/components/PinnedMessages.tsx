import { useEffect, useRef, useState } from 'react'
import { PinOff } from 'lucide-react'
import { api, Message } from '../api'
import Avatar from './Avatar'
import { styledNameProps } from '../nameStyle'

/**
 * Список закреплённых сообщений канала — попап под кнопкой в шапке чата,
 * как в Discord.
 *
 * Содержимое каждый раз запрашивается заново (api.channelPins), а не живёт
 * в состоянии рядом с лентой: закреплённое может быть сколь угодно далеко в
 * истории, до которой постраничная лента не доехала, а само закрепление
 * происходит редко — держать ради него ещё один синхронизируемый по
 * WebSocket список дороже, чем один запрос на открытие панели.
 */
export default function PinnedMessages({
  channelId,
  canPin,
  onUnpin,
  onClose,
}: {
  channelId: number
  /** Есть ли право модерации сообщений — от него зависит крестик «открепить». */
  canPin: boolean
  onUnpin: (messageId: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api.channelPins(channelId)
        if (!cancelled) setMessages(data)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [channelId])

  // Закрытие по клику вне себя/Escape — тот же приём, что у контекстных меню.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className="pinned-panel" ref={ref}>
      <div className="pinned-panel-title">Закреплённые сообщения</div>
      {error && <div className="pinned-panel-empty">{error}</div>}
      {!error && messages == null && <div className="pinned-panel-empty">Загрузка…</div>}
      {!error && messages != null && messages.length === 0 && (
        <div className="pinned-panel-empty">
          В этом канале пока ничего не закреплено.
        </div>
      )}
      {messages?.map((m) => (
        <div className="pinned-item" key={m.id}>
          <Avatar
            name={m.author.username}
            color={m.author.avatar_color}
            image={m.author.avatar_image}
            size={28}
          />
          <div className="pinned-item-body">
            <span
              className={`pinned-item-author ${styledNameProps(m.author).className}`}
              style={styledNameProps(m.author).style}
            >
              {m.author.username}
            </span>
            <div className="pinned-item-content">
              {m.content || (m.attachments.length > 0 ? 'Вложение' : '')}
            </div>
          </div>
          {canPin && (
            <button
              type="button"
              className="icon-btn pinned-item-unpin"
              title="Открепить"
              onClick={() => {
                onUnpin(m.id)
                // Ответ придёт по WebSocket всем, но панель свой список
                // перечитывает только при открытии — убираем строку сразу.
                setMessages((prev) => prev?.filter((x) => x.id !== m.id) ?? prev)
              }}
            >
              <PinOff size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
