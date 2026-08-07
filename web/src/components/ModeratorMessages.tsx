import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, CornerUpRight, Copy, Hash, Loader2, Paperclip } from 'lucide-react'
import {
  Attachment, ModeratorMessage, ModeratorMessageKind, api, mediaUrl,
} from '../api'
import { STICKER_TOKEN_RE } from '../emoji'
import { renderSimpleMarkdown } from '../markdown'

/** Текст без токенов стикеров/кастомных эмодзи — в узкой колонке досье
 * сырое «<sticker:42>» только мешает читать. Пустая строка после чистки
 * означает сообщение из одной картинки: под ним всё равно будут вложения. */
function readableText(content: string): string {
  return content.replace(STICKER_TOKEN_RE, '[стикер]').trim()
}

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/** Компактное превью вложений: картинки — плиткой, остальное — чипом с
 * расширением. Не переиспользует MessageAttachments намеренно: та рассчитана
 * на ширину ленты (галерея, плеер голосовых, скачивание), а здесь 420px
 * колонки и задача «понять, что это было», а не рассмотреть. */
function AttachmentStrip({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="moderator-msg-files">
      {attachments.map((a) =>
        a.content_type.startsWith('image/') ? (
          <img
            key={a.id}
            className="moderator-msg-thumb"
            src={mediaUrl(a.url)}
            alt={a.original_name}
            title={a.original_name}
            loading="lazy"
          />
        ) : (
          <span key={a.id} className="moderator-msg-file" title={a.original_name}>
            <Paperclip size={11} />
            {a.original_name.split('.').pop()?.slice(0, 4).toUpperCase() || 'ФАЙЛ'}
          </span>
        ),
      )}
    </div>
  )
}

/**
 * Мини-чат под счётчиками панели модератора: что участник писал на сервере,
 * целиком / только со ссылками / только с вложениями.
 *
 * Открывается кликом по строке «Активность сервера» и ЗАМЕЩАЕТ тело панели,
 * а не наслаивается поверх: колонка узкая, и попап внутри неё был бы теснее
 * того же места, а кнопка «назад» возвращает к досье одним движением.
 *
 * Порядок хронологический, как в настоящем чате, с автопрокруткой вниз —
 * свежее сразу перед глазами, а листать вверх можно как в обычной ленте.
 */
export default function ModeratorMessages({
  serverId,
  userId,
  kind,
  title,
  onBack,
  onJump,
}: {
  serverId: number
  userId: number
  kind: ModeratorMessageKind
  /** Подпись в шапке — та же, что у строки, из которой сюда пришли. */
  title: string
  onBack: () => void
  /** Перейти к сообщению в основном чате: переключает канал и прокручивает
   * ленту к нему (см. AppShell.jumpToMessage). Не задан — пункт перехода не
   * показывается вовсе (сейчас так не бывает, но меню не должно предлагать
   * действие, которое некому выполнить). */
  onJump?: (channelId: number, messageId: number) => void
}) {
  const [messages, setMessages] = useState<ModeratorMessage[] | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ message: ModeratorMessage; x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setMessages(null)
    setError('')
    void (async () => {
      try {
        const data = await api.moderatorMessages(serverId, userId, kind)
        if (!cancelled) setMessages(data)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverId, userId, kind])

  // Вниз — до первого кадра, иначе мелькнёт верх списка и дёрнется.
  useLayoutEffect(() => {
    if (messages && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

  const closeMenu = useCallback(() => setMenu(null), [])

  return (
    <>
      <div className="moderator-panel-title moderator-msg-title">
        <button
          type="button"
          className="moderator-msg-back"
          title="Назад к досье"
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </button>
        {title}
        {messages && <span className="moderator-panel-count">{messages.length}</span>}
      </div>

      {!messages && !error && (
        <div className="moderator-panel-placeholder">
          <Loader2 size={18} className="spin" /> Загружаем сообщения…
        </div>
      )}
      {error && <div className="moderator-panel-error">{error}</div>}

      {messages && messages.length === 0 && (
        <div className="moderator-panel-placeholder">Здесь пусто</div>
      )}

      {messages && messages.length > 0 && (
        <div className="moderator-msg-list" ref={listRef}>
          {messages.map((m) => {
            const text = readableText(m.content)
            return (
              <div
                key={m.id}
                className={`moderator-msg ${menu?.message.id === m.id ? 'active' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ message: m, x: e.clientX, y: e.clientY })
                }}
              >
                <div className="moderator-msg-head">
                  <span className="moderator-msg-channel">
                    <Hash size={11} />
                    {m.channel_name}
                  </span>
                  <span className="moderator-msg-time">{formatStamp(m.created_at)}</span>
                </div>
                {text && (
                  <div className="moderator-msg-text">
                    {renderSimpleMarkdown(text, `mm-${m.id}`)}
                  </div>
                )}
                {m.attachments.length > 0 && (
                  <AttachmentStrip attachments={m.attachments} />
                )}
              </div>
            )
          })}
        </div>
      )}

      {menu && (
        <MessageJumpMenu
          message={menu.message}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onJump={onJump}
        />
      )}
    </>
  )
}

/**
 * Правый клик по строке мини-чата. Своё меню, а не общий MessageContextMenu:
 * тот про работу С сообщением в его ленте (реакции, ответ, пересылка,
 * закрепление) и тянет за собой весь конвейер канала — отвечать из чужого
 * досье на сообщение в другом канале нечем и незачем. Здесь ровно два
 * осмысленных действия: уйти к сообщению и забрать текст.
 *
 * Позиционирование и закрытие — тот же приём, что у остальных меню проекта
 * (см. MessageContextMenu): прижатие к краю экрана в useLayoutEffect,
 * закрытие по клику мимо и по Escape.
 */
function MessageJumpMenu({
  message,
  x,
  y,
  onClose,
  onJump,
}: {
  message: ModeratorMessage
  x: number
  y: number
  onClose: () => void
  onJump?: (channelId: number, messageId: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height
    }
    el.style.left = `${Math.max(margin, left)}px`
    el.style.top = `${Math.max(margin, top)}px`
  }, [x, y])

  useLayoutEffect(() => {
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

  const text = readableText(message.content)

  return (
    <div ref={ref} className="profile-popup message-context-menu" style={{ left: x, top: y }}>
      <div className="profile-popup-menu">
        {onJump && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => {
              onJump(message.channel_id, message.id)
              onClose()
            }}
          >
            <CornerUpRight size={15} /> Перейти к сообщению
          </button>
        )}
        {text && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={() => {
              void navigator.clipboard.writeText(text)
              onClose()
            }}
          >
            <Copy size={15} /> Скопировать текст
          </button>
        )}
      </div>
    </div>
  )
}
