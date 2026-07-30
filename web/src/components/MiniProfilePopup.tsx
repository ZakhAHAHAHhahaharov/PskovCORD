import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  Calendar, Check, Copy, Download, UserPlus, UserCheck, UserMinus, Loader2,
  MessageSquare, NotebookPen, Smile,
} from 'lucide-react'
import { api, NameEffect } from '../api'
import { loadAvatarAnimation } from '../avatarAnim'
import { useEscToClose } from '../modalStack'
import ProfileCardHeader from './ProfileCardHeader'
import InlineEditableText from './InlineEditableText'

export interface ProfilePopupUser {
  id: number
  username: string
  /** Пусто — карточка показывает только username. */
  display_name?: string
  avatar_color: string
  avatar_image: string
  /** У аватара есть гифка (см. avatarAnim.ts) — в карточке она играет всегда. */
  avatar_animated?: boolean
  /** Владелец разрешил скачивать аватар — иначе кнопки скачивания нет. */
  avatar_downloadable?: boolean
  banner_gradient?: string
  banner_image?: string
  status?: 'online' | 'dnd' | 'offline' | 'invisible'
  /** Стиль ника (см. nameStyle.ts) — приходит вместе с любым User/Member,
   * которым открыли этот попап (клик по сообщению/ростеру/списку участников). */
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
  name_anim_speed: number
}

export interface ProfilePopupTarget {
  user: ProfilePopupUser
  /** Координаты клика (clientX/clientY) — попап всплывает рядом с ним. */
  x: number
  y: number
}

/**
 * Мини-профиль — всплывает рядом с кликом по аватарке/нику где угодно (чат,
 * список участников, войс-канал). Переиспользует .profile-popup из
 * StatusMenu (тот же вид карточки), но позиционируется у курсора, а не под
 * триггером, и живёт на уровне AppShell, а не внутри конкретного списка.
 */
export default function MiniProfilePopup({
  target,
  currentUserId,
  isFriend,
  onClose,
  onAddFriend,
  onSendMessage,
  onRemoveFriend,
}: {
  target: ProfilePopupTarget
  currentUserId: number
  /** Уже друзья — вместо «Добавить в друзья» показываем пометку (попап
   * теперь открывается и прямо из списка друзей, см. HomeSidebar). */
  isFriend: boolean
  onClose: () => void
  /** Возвращает успех — попап сам показывает отклик на кнопке (см. addStatus). */
  onAddFriend: (userId: number) => Promise<boolean>
  onSendMessage: (userId: number, content: string) => void
  /** «Удалить из друзей» — тот же обработчик, что и у одноимённого пункта в
   * контекстном меню диалога (см. ConversationContextMenu). */
  onRemoveFriend: (userId: number) => Promise<boolean>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')
  const [addStatus, setAddStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [removing, setRemoving] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { user } = target

  const handleAddFriend = async () => {
    if (addStatus !== 'idle') return
    setAddStatus('sending')
    const ok = await onAddFriend(user.id)
    setAddStatus(ok ? 'sent' : 'idle')
  }
  const isSelf = user.id === currentUserId

  // Тяжёлые/редко нужные поля чужого профиля не приходят вместе с самим
  // профилем (баннер — до 4 МБ data-URL, а сам ProfilePopupUser собирается
  // из message.author/строки ростера, которые летят в КАЖДОМ сообщении) —
  // догружаем ровно здесь, когда карточку реально открыли. Тот же приём,
  // что уже был для bio/баннера, просто заодно все новые поля карточки.
  const [card, setCard] = useState<{
    gradient: string
    image: string
    color: string
    bio: string
    pronouns: string
    customStatus: string
    customStatusEmoji: string
    dateJoined: string
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api.profileCard(user.id)
        if (!cancelled) {
          setCard({
            gradient: data.banner_gradient,
            image: data.banner_image,
            color: data.banner_color,
            bio: data.bio,
            pronouns: data.pronouns,
            customStatus: data.custom_status,
            customStatusEmoji: data.custom_status_emoji,
            dateJoined: data.date_joined,
          })
        }
      } catch {
        // Нет доступа или сеть — просто оставим фон по умолчанию, без остального.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user.id])

  // Приватная заметка (видна только автору, своя у каждого просматривающего)
  // — не имеет смысла на своём же профиле, лениво грузим только для чужого.
  const [note, setNote] = useState('')
  // Пока заметка не приехала, поля нет вовсе. Иначе успевшая начаться правка
  // пустого поля затиралась бы ответом сервера (или, наоборот, сохраняла бы
  // пустоту поверх реальной заметки — InlineEditableText берёт value в момент
  // клика).
  const [noteLoaded, setNoteLoaded] = useState(false)
  useEffect(() => {
    if (isSelf) return
    let cancelled = false
    void (async () => {
      try {
        const data = await api.getUserNote(user.id)
        if (!cancelled) {
          setNote(data.text)
          setNoteLoaded(true)
        }
      } catch {
        // Нет доступа/сеть — поле не показываем: сохранить всё равно не выйдет.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user.id, isSelf])

  const bannerGradient = card?.gradient ?? user.banner_gradient
  const bannerImage = card?.image ?? user.banner_image
  const bannerColor = card?.color ?? ''

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let left = target.x
    let top = target.y
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height
    }
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [target.x, target.y])

  useEscToClose(onClose)

  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  const handleComposeKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const content = message.trim()
      if (!content) return
      onSendMessage(user.id, content)
    }
  }

  // Скачивание аватара. Гифку (если аватар анимированный) берём отдельным
  // запросом — в самом профиле её нет, только выбранный кадр (см.
  // avatarAnim.ts); для обычного аватара скачивается то, что и так на руках.
  const [downloading, setDownloading] = useState(false)
  const downloadAvatar = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const anim = user.avatar_animated ? await loadAvatarAnimation(user.id) : ''
      const source = anim || user.avatar_image
      if (!source) return
      const link = document.createElement('a')
      link.href = source
      link.download = `${user.username}-avatar.${anim ? 'gif' : 'jpg'}`
      link.click()
    } finally {
      setDownloading(false)
    }
  }

  const copyId = () => {
    navigator.clipboard.writeText(String(user.id)).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  const joinedDate = card?.dateJoined
    ? new Date(card.dateJoined).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric',
      })
    : null

  return (
    <div
      ref={ref}
      className="profile-popup mini-profile-popup"
      style={{ left: target.x, top: target.y }}
    >
      <ProfileCardHeader
        username={user.username}
        displayName={user.display_name || ''}
        avatarColor={user.avatar_color}
        avatarImage={user.avatar_image}
        userId={user.id}
        avatarAnimated={!!user.avatar_animated}
        bannerGradient={bannerGradient}
        bannerImage={bannerImage}
        bannerColor={bannerColor}
        status={user.status}
        customStatus={card?.customStatus || ''}
        customStatusEmoji={card?.customStatusEmoji || ''}
        pronouns={card?.pronouns || ''}
        nameStyle={user}
      />

      <div className="profile-popup-menu">
        {!isSelf && (
          isFriend ? (
            <button
              type="button"
              className="profile-popup-item mini-profile-action"
              disabled={removing}
              onClick={async () => {
                setRemoving(true)
                const ok = await onRemoveFriend(user.id)
                // Успех сам уберёт кнопку (isFriend пересчитается снаружи),
                // поэтому снимаем блокировку только если не вышло.
                if (!ok) setRemoving(false)
              }}
            >
              {removing ? <Loader2 size={15} className="spin" /> : <UserMinus size={15} />}
              {removing ? 'Удаляем…' : 'Удалить из друзей'}
            </button>
          ) : (
            <button
              type="button"
              className={`profile-popup-item mini-profile-action ${
                addStatus === 'sent' ? 'mini-profile-action-sent' : ''
              }`}
              disabled={addStatus !== 'idle'}
              onClick={handleAddFriend}
            >
              {addStatus === 'sending' ? (
                <Loader2 size={15} className="spin" />
              ) : addStatus === 'sent' ? (
                <UserCheck size={15} />
              ) : (
                <UserPlus size={15} />
              )}
              {addStatus === 'sending'
                ? 'Отправляем…'
                : addStatus === 'sent'
                  ? 'Заявка отправлена'
                  : 'Добавить в друзья'}
            </button>
          )
        )}

        {composing ? (
          <div className="mini-profile-compose">
            <input
              className="mini-profile-compose-input"
              placeholder={`Сообщение для ${user.username}`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleComposeKeyDown}
              autoFocus
            />
            <button
              type="button"
              className="mini-profile-compose-emoji"
              title="Эмодзи (пока не реализовано)"
              disabled
            >
              <Smile size={16} />
            </button>
          </div>
        ) : (
          <div className="profile-modal-actions-row profile-modal-actions-row-stacked">
            {!isSelf && (
              <button
                type="button"
                className="profile-popup-item mini-profile-action"
                onClick={() => setComposing(true)}
              >
                <MessageSquare size={15} /> Написать сообщение
              </button>
            )}
            <button type="button" className="profile-popup-item" onClick={copyId}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Скопировано' : 'Копировать ID'}
            </button>
            {/* Скачивание аватара — только если владелец его разрешил (см.
                accounts.models.User.avatar_downloadable). Это вежливость, а
                не запрет: картинка и так в браузере у каждого, кто видит
                профиль. У анимированного аватара скачивается гифка целиком,
                у обычного — сама картинка. */}
            {user.avatar_image && user.avatar_downloadable !== false && (
              <button
                type="button"
                className="profile-popup-item"
                onClick={downloadAvatar}
                disabled={downloading}
              >
                {downloading ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                Скачать аватар
              </button>
            )}
          </div>
        )}
      </div>

      {card?.bio && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-bio">{card.bio}</div>
        </>
      )}

      {joinedDate && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-modal-section">
            <div className="profile-modal-section-title">
              <Calendar size={13} /> В числе участников с
            </div>
            <div className="profile-modal-section-value">{joinedDate}</div>
          </div>
        </>
      )}

      {!isSelf && noteLoaded && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-modal-section">
            <div className="profile-modal-section-title">
              <NotebookPen size={13} /> Заметка (видна только вам)
            </div>
            <InlineEditableText
              className="profile-popup-note"
              value={note}
              placeholder="Нажмите, чтобы добавить заметку"
              maxLength={300}
              multiline
              onSave={async (text) => {
                await api.setUserNote(user.id, text)
                setNote(text)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
