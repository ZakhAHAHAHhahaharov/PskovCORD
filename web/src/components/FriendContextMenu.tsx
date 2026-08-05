import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AtSign, Ban, BellOff, Check, MessageSquare, NotebookPen, Phone, ServerIcon,
  Shield, ShieldBan, Tag, User as UserIcon, UserMinus, UserPlus, UserX,
} from 'lucide-react'
import { api, Role, Server, UserRelation } from '../api'
import { useHoverFlyout } from '../hooks/useHoverFlyout'
import { useNickname } from '../nicknames'
import { ProfilePopupUser } from './MiniProfilePopup'
import { serverInitials } from './ServerRail'

/**
 * Правый клик по строке друга в списке «Друзья» (см. HomeSidebar) — и по
 * любому другому человеку вне списка друзей (см. isFriend), например по
 * отреагировавшему на сообщение (см. MessageReactionsModal).
 *
 * Позиционирование и закрытие по клику вне себя/Escape — тот же приём, что в
 * ConversationContextMenu/ChannelContextMenu. Пункты про беседу с другом
 * (закрепить, пометить прочитанным, закрыть ЛС) сюда намеренно не попадают —
 * они живут в меню диалога; здесь только то, что про самого человека.
 *
 * Игнор/блокировка устроены так же, как в ConversationContextMenu: приезжают
 * с сервера лениво, уже после открытия меню, а не тащатся в списке друзей
 * заранее ради двух флажков, которые нужны ровно здесь.
 */
export default function FriendContextMenu({
  friend,
  isFriend,
  x,
  y,
  servers,
  onClose,
  onOpenProfile,
  onSendMessage,
  onStartCall,
  onAddNote,
  onSetNickname,
  onInviteToServer,
  onAddFriend,
  onRemoveFriend,
  onRelationChange,
  onMention,
  onSetServerNickname,
  rolesMenu,
  onKick,
  onBan,
}: {
  friend: ProfilePopupUser
  /** Уже в друзьях — переключает нижний пункт между «Удалить»/«Добавить в
   * друзья» (см. onAddFriend/onRemoveFriend). */
  isFriend: boolean
  x: number
  y: number
  /** Мои серверы — из них выбирается, куда пригласить друга. */
  servers: Server[]
  onClose: () => void
  onOpenProfile: () => void
  onSendMessage: () => void
  onStartCall: () => void
  /** Открыть карточку профиля — заметка редактируется прямо в ней (см.
   * MiniProfilePopup), отдельной модалки под одно поле не заводим. */
  onAddNote: () => void
  onSetNickname: () => void
  onInviteToServer: (serverId: number) => void
  onAddFriend: () => void
  onRemoveFriend: () => void
  /** Игнор/блокировка изменились — обновить состояние снаружи (лента,
   * уведомления). */
  onRelationChange: (relation: UserRelation) => void
  /** Упомянуть в текущем открытом канале/диалоге — undefined, если сейчас ни
   * один не открыт (тогда пункт скрыт, вставлять "@Ник " было бы некуда). */
  onMention?: () => void
  /** Никнейм НА СЕРВЕРЕ (публичный, см. ServerNicknameModal) — задан, только
   * если открыли в текстовом канале сервера и есть право manage_nicknames.
   * Вытесняет приватный никнейм друга (onSetNickname) в пункте меню: оба
   * смысла одному пункту не нужны, а приватный никнейм остаётся доступен
   * через карточку профиля. */
  onSetServerNickname?: () => void
  /** Роли участника на сервере — есть, только если цель является участником
   * сервера в открытом сейчас текстовом канале (см. AppShellOverlays).
   * canManage — есть право manage_roles И цель ниже меня в иерархии
   * (см. backend chat.roles.can_manage_role/can_act_on_member); без этого
   * флажки показываются, но задизейблены — как и было решено в задаче. */
  rolesMenu?: {
    roles: Role[]
    targetRoleIds: number[]
    canManage: boolean
    onToggle: (roleId: number, on: boolean) => void
  }
  /** «Выгнать» — есть, только если у меня manage_members на сервере и цель
   * ниже меня в иерархии (см. backend can_act_on_member). */
  onKick?: () => void
  /** «Забанить» — то же самое, но по ban_members/manage_members. */
  onBan?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const nickname = useNickname(friend.id)
  const [relation, setRelation] = useState<UserRelation | null>(null)
  const serversFlyout = useHoverFlyout()
  const rolesFlyout = useHoverFlyout()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api.getUserRelation(friend.id)
        if (!cancelled) setRelation(data)
      } catch {
        // Не смогли узнать — пункты просто останутся в состоянии «выкл»,
        // нажатие всё равно отправит нужное значение.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [friend.id])

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

  /** Переключить игнор/блокировку — тот же приём, что и в ConversationContextMenu:
   * сервер отдаёт ровно то же, что мы и попросили, ждать ответа незачем. */
  const toggleRelation = async (field: keyof UserRelation) => {
    const next: UserRelation = {
      ignored: relation?.ignored ?? false,
      blocked: relation?.blocked ?? false,
      [field]: !(relation?.[field] ?? false),
    }
    setRelation(next)
    onRelationChange(next)
    onClose()
    try {
      await api.setUserRelation(friend.id, { [field]: next[field] })
    } catch {
      // Откатывать нечего: меню уже закрыто, а следующее открытие
      // перечитает настоящее состояние с сервера.
    }
  }

  const item = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      type="button"
      className="profile-popup-item"
      onClick={() => {
        onClick()
        onClose()
      }}
    >
      {icon} {label}
    </button>
  )

  // Флаут серверов раскрывается вправо, а у правого края экрана — влево
  // (см. тот же расчёт в ConversationContextMenu).
  const flyoutLeft = x + 280 + 230 > window.innerWidth

  return (
    <div ref={ref} className="profile-popup channel-context-menu" style={{ left: x, top: y }}>
      <div className="profile-popup-menu">
        {item(<UserIcon size={15} />, 'Профиль', onOpenProfile)}
        {onMention && item(<AtSign size={15} />, 'Упомянуть', onMention)}
        {item(<MessageSquare size={15} />, 'Написать сообщение', onSendMessage)}
        {item(<Phone size={15} />, 'Начать звонок', onStartCall)}
        {item(<NotebookPen size={15} />, 'Добавить заметку', onAddNote)}
        {(onSetServerNickname || isFriend) &&
          item(
            <Tag size={15} />,
            onSetServerNickname ? 'Изменить никнейм' : nickname ? 'Изменить никнейм друга' : 'Добавить никнейм друга',
            onSetServerNickname ?? onSetNickname,
          )}
      </div>

      {servers.length > 0 && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-menu">
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
                <div className={`conversation-menu-flyout ${flyoutLeft ? 'flyout-left' : ''}`}>
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

      <div className="profile-popup-divider" />
      <div className="profile-popup-menu">
        {isFriend
          ? item(<UserMinus size={15} />, 'Удалить из друзей', onRemoveFriend)
          : item(<UserPlus size={15} />, 'Добавить в друзья', onAddFriend)}
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

      {rolesMenu && rolesMenu.roles.length > 0 && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-menu">
            <div
              className="conversation-menu-servers"
              onMouseEnter={rolesFlyout.onMouseEnter}
              onMouseLeave={rolesFlyout.onMouseLeave}
            >
              <button type="button" className="profile-popup-item">
                <Shield size={15} /> Роли
                <span className="conversation-menu-chevron">{flyoutLeft ? '◂' : '▸'}</span>
              </button>
              {rolesFlyout.open && (
                <div className={`conversation-menu-flyout ${flyoutLeft ? 'flyout-left' : ''}`}>
                  {rolesMenu.roles.map((r) => (
                    <label
                      key={r.id}
                      className="profile-popup-item conversation-menu-server channel-ctx-checkbox-item"
                    >
                      <input
                        type="checkbox"
                        checked={rolesMenu.targetRoleIds.includes(r.id)}
                        disabled={!rolesMenu.canManage}
                        onChange={(e) => rolesMenu.onToggle(r.id, e.target.checked)}
                      />
                      <span className="srv-role-dot" style={{ background: r.color }} />
                      <span className="conversation-menu-server-name">{r.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {(onBan || onKick) && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-menu">
            {onBan && item(<ShieldBan size={15} />, 'Забанить', onBan)}
            {onKick && item(<UserX size={15} />, 'Выгнать', onKick)}
          </div>
        </>
      )}
    </div>
  )
}
