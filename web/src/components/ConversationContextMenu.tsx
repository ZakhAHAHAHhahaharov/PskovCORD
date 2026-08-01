import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Ban, BellOff, Check, CheckCheck, MessageSquare, MessageSquareOff, NotebookPen, Phone, Pin,
  ServerIcon, User as UserIcon, UserMinus,
} from 'lucide-react'
import { api, Conversation, Server, UserRelation } from '../api'
import { useHoverFlyout } from '../hooks/useHoverFlyout'
import { serverInitials } from './ServerRail'

/**
 * Правый клик по диалогу/группе в списке «Диалоги» (см. HomeSidebar).
 * Позиционирование и закрытие по клику вне себя/Escape — тот же приём, что в
 * ChannelContextMenu/ServerContextMenu.
 *
 * Набор пунктов зависит от вида беседы: всё, что про КОНКРЕТНОГО человека
 * (профиль, заметка, друзья, игнор, блокировка, приглашение на сервер), в
 * группе смысла не имеет — там собеседников несколько, и адресата у такого
 * действия нет. Поэтому в группе остаются только «прочитано», «закрепить» и
 * звонок.
 *
 * Игнор и блокировка приезжают с сервера лениво, уже после открытия меню
 * (api.getUserRelation): держать их в списке бесед было бы лишним весом в
 * каждом ответе ради двух флажков, которые нужны ровно здесь.
 */
export default function ConversationContextMenu({
  conversation,
  x,
  y,
  isFriend,
  servers,
  onClose,
  onMarkRead,
  onTogglePin,
  onOpenProfile,
  onSendMessage,
  onStartCall,
  onAddNote,
  onCloseConversation,
  onInviteToServer,
  onRemoveFriend,
  onRelationChange,
}: {
  conversation: Conversation
  x: number
  y: number
  /** Показывать ли «Удалить из друзей» — для чужих, кто в друзьях. */
  isFriend: boolean
  /** Мои серверы — из них выбирается, куда пригласить собеседника. */
  servers: Server[]
  onClose: () => void
  onMarkRead: () => void
  onTogglePin: () => void
  onOpenProfile: () => void
  /** Переключиться на эту же беседу (тот же эффект, что клик по строке в
   * списке) — пункт для тех, кто открыл меню правым кликом, а не левым. */
  onSendMessage: () => void
  onStartCall: () => void
  /** Открыть карточку профиля — заметка редактируется прямо в ней. */
  onAddNote: () => void
  onCloseConversation: () => void
  onInviteToServer: (serverId: number) => void
  onRemoveFriend: () => void
  /** Игнор/блокировка изменились — обновить состояние снаружи (лента,
   * уведомления). */
  onRelationChange: (relation: UserRelation) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isDm = conversation.kind === 'dm'
  const peer = isDm ? conversation.participants[0] : null
  const [relation, setRelation] = useState<UserRelation | null>(null)
  // Список серверов — боковой флаут по наведению (см. useHoverFlyout): у
  // строки «Пригласить на сервер» нет собственного действия по клику, только
  // выбор сервера, поэтому лишний клик на раскрытие тут ни к чему.
  const serversFlyout = useHoverFlyout()

  // Игнор/блокировка — только для лички и только когда меню уже открыли.
  useEffect(() => {
    if (!peer) return
    let cancelled = false
    void (async () => {
      try {
        const data = await api.getUserRelation(peer.id)
        if (!cancelled) setRelation(data)
      } catch {
        // Не смогли узнать — пункты просто останутся в состоянии «выкл»,
        // нажатие всё равно отправит нужное значение.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [peer])

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

  /** Переключить игнор/блокировку. Оптимистично: сервер отдаёт ровно то же,
   * что мы и попросили, а ждать ответа ради галочки в меню незачем. */
  const toggleRelation = async (field: keyof UserRelation) => {
    if (!peer) return
    const next: UserRelation = {
      ignored: relation?.ignored ?? false,
      blocked: relation?.blocked ?? false,
      [field]: !(relation?.[field] ?? false),
    }
    setRelation(next)
    onRelationChange(next)
    onClose()
    try {
      await api.setUserRelation(peer.id, { [field]: next[field] })
    } catch {
      // Откатывать нечего: меню уже закрыто, а следующее открытие
      // перечитает настоящее состояние с сервера.
    }
  }

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    extra?: React.ReactNode,
  ) => (
    <button
      type="button"
      className="profile-popup-item"
      onClick={() => {
        onClick()
        onClose()
      }}
    >
      {icon} {label}
      {extra}
    </button>
  )

  // Заголовок — только у группы (её название не очевидно из самой строки
  // списка, если она безымянная и собрана из ников). В личке его нет вовсе:
  // ник собеседника и так написан в строке, по которой только что кликнули
  // правой кнопкой, — дублировать его шапкой меню незачем.
  const title = isDm
    ? null
    : conversation.name || conversation.participants.map((p) => p.username).join(', ')

  // Флаут серверов раскрывается вправо, а у правого края экрана — влево:
  // 280px самого меню + ~230px флаута легко не помещаются в остаток ширины.
  const flyoutLeft = x + 280 + 230 > window.innerWidth

  return (
    <div ref={ref} className="profile-popup channel-context-menu" style={{ left: x, top: y }}>
      {title && <div className="profile-popup-label">{title}</div>}

      <div className="profile-popup-menu">
        {item(<CheckCheck size={15} />, 'Пометить как прочитанное', onMarkRead)}
        {item(
          <Pin size={15} />,
          conversation.pinned ? 'Открепить' : 'Закрепить',
          onTogglePin,
        )}
        {isDm && item(<UserIcon size={15} />, 'Профиль', onOpenProfile)}
        {isDm && item(<MessageSquare size={15} />, 'Написать сообщение', onSendMessage)}
        {item(<Phone size={15} />, 'Начать звонок', onStartCall)}
        {isDm && item(<NotebookPen size={15} />, 'Добавить заметку', onAddNote)}
      </div>

      {isDm && servers.length > 0 && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-menu">
            {/* Подменю — боковой флаут по наведению, а не раскрывающийся
                список внутри меню: список серверов может быть длинным, и
                внутри он растягивал бы само меню, уводя нижние пункты за
                край экрана. Зазора между строкой и флаутом нет (флаут
                перекрывает его собой), поэтому mouseleave обёртки не ловит
                курсор по дороге — см. useHoverFlyout. */}
            <div
              className="conversation-menu-servers"
              onMouseEnter={serversFlyout.onMouseEnter}
              onMouseLeave={serversFlyout.onMouseLeave}
            >
              <button type="button" className="profile-popup-item">
                <ServerIcon size={15} /> Пригласить на сервер
                <span className="conversation-menu-chevron">{flyoutLeft ? '◂' : '▸'}</span>
              </button>
              {serversFlyout.open && (
                <div
                  className={`conversation-menu-flyout ${flyoutLeft ? 'flyout-left' : ''}`}
                >
                  {servers.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="profile-popup-item conversation-menu-server"
                      onClick={() => {
                        onInviteToServer(s.id)
                        onClose()
                      }}
                    >
                      {s.icon ? (
                        <img className="conversation-menu-server-icon" src={s.icon} alt="" />
                      ) : (
                        <span className="conversation-menu-server-icon conversation-menu-server-initials">
                          {serverInitials(s.name)}
                        </span>
                      )}
                      <span className="conversation-menu-server-name">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {isDm && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-menu">
            {item(<MessageSquareOff size={15} />, 'Закрыть ЛС', onCloseConversation)}
            {isFriend && item(<UserMinus size={15} />, 'Удалить из друзей', onRemoveFriend)}
            <button
              type="button"
              className="profile-popup-item"
              onClick={() => void toggleRelation('ignored')}
            >
              <BellOff size={15} /> Игнорировать
              {relation?.ignored && <Check size={14} className="conversation-menu-check" />}
            </button>
            <button
              type="button"
              className="profile-popup-item profile-popup-item-danger"
              onClick={() => void toggleRelation('blocked')}
            >
              <Ban size={15} /> {relation?.blocked ? 'Разблокировать' : 'Заблокировать'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
