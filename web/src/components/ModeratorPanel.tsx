import { useCallback, useEffect, useState } from 'react'
import {
  BadgeAlert, ChevronRight, FileImage, Gavel, Hash, Link as LinkIcon,
  Loader2, MessageSquare, RefreshCw, ScrollText, Shield, UserMinus, UserRound, X,
} from 'lucide-react'
import { api, AuditLogEntry, JoinMethod, ModeratorView, Role } from '../api'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'
import { ProfilePopupUser } from './MiniProfilePopup'

const JOIN_METHOD_LABEL: Record<JoinMethod, string> = {
  unknown: 'Неизвестно',
  public: 'Открытый сервер',
  invite_link: 'Ссылка-приглашение',
  invite_direct: 'Личное приглашение',
  request: 'Одобренная заявка',
  owner: 'Создатель сервера',
}

const ACTION_LABEL: Record<AuditLogEntry['action'], string> = {
  join: 'Вступил на сервер',
  leave: 'Покинул сервер',
  kick: 'Выгнан с сервера',
  ban: 'Забанен',
  unban: 'Разбанен',
  role_add: 'Выдана роль',
  role_remove: 'Снята роль',
  nickname: 'Изменён никнейм',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/** Подпись под действием — то, что делает запись журнала осмысленной:
 * причина бана, какая именно роль, из чего в что переименовали. */
function auditDetail(entry: AuditLogEntry): string {
  const d = entry.details
  switch (entry.action) {
    case 'ban':
      return d.reason || 'без указания причины'
    case 'role_add':
    case 'role_remove':
      return d.role_name || ''
    case 'nickname':
      return `${d.before || '—'} → ${d.after || '—'}`
    case 'join':
      return d.invited_by_username
        ? `пригласил ${d.invited_by_username}`
        : JOIN_METHOD_LABEL[(d.method as JoinMethod) ?? 'unknown']
    default:
      return ''
  }
}

/**
 * Панель модератора — досье на участника сервера, вызывается пунктом
 * «Открыть в панели модератора» контекстного меню человека (см.
 * FriendContextMenu).
 *
 * Встаёт в колонку списка участников и СДВИГАЕТ его вправо, а не подменяет
 * собой: модерируя человека, обычно надо видеть и остальной ростер (кто ещё
 * онлайн, кому эта же роль уже выдана). Раскладку задаёт грид .app —
 * четвёртая колонка появляется вместе с панелью (см. index.css).
 *
 * Данные тянутся одним запросом при открытии и при смене цели. Живых
 * обновлений по WS нет намеренно: досье — это срез на момент открытия, и
 * дёргающиеся под курсором цифры мешали бы читать; вместо этого есть кнопка
 * «обновить» в шапке.
 */
export default function ModeratorPanel({
  serverId,
  target,
  roles,
  canManageMembers,
  canBan,
  canActOnTarget,
  reloadToken,
  onClose,
  onSendMessage,
  onKick,
  onBan,
}: {
  serverId: number
  target: ProfilePopupUser
  /** Роли сервера — чтобы показать цвет и имя по id из сводки. */
  roles: Role[]
  /** Право manage_members у СМОТРЯЩЕГО — от него зависит кнопка «выгнать». */
  canManageMembers: boolean
  canBan: boolean
  /** Цель ниже меня в иерархии (см. backend can_act_on_member). Без этого
   * кнопки модерации задизейблены: сервер их всё равно отклонит. */
  canActOnTarget: boolean
  /** Меняется, когда снаружи произошло что-то, попадающее в сводку — сейчас
   * это успешный бан из модалки (см. AppShellOverlays). Кик панель
   * перечитывает сама, а бан уезжает в отдельное окно и её не касается. */
  reloadToken: number
  onClose: () => void
  onSendMessage: () => void
  /** Оба действия делает владелец состояния снаружи (см. AppShellOverlays) —
   * панель только зовёт и потом перечитывает сводку. */
  onKick: () => Promise<void> | void
  onBan: () => Promise<void> | void
}) {
  useEscToClose(onClose)
  const [data, setData] = useState<ModeratorView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.moderatorView(serverId, target.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
    // reloadToken в зависимостях намеренно: его смена и есть сигнал
    // «перечитай», хотя сам он в теле не используется.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, target.id, reloadToken])

  useEffect(() => {
    void load()
  }, [load])

  /** ID участника — им ищут человека в логах и обращениях в поддержку.
   * Галочка вместо иконки на пару секунд — единственная обратная связь,
   * по которой видно, что копирование вообще случилось. */
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(String(target.id))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Буфер недоступен (нет https / отказали в доступе) — молча: своя
      // ошибка на весь экран ради невставленного числа была бы хуже.
    }
  }

  const grantedPermissions = data
    ? Object.entries(data.permissions).filter(([, on]) => on)
    : []
  const memberRoles = data
    ? roles.filter((r) => data.role_ids.includes(r.id))
    : []

  const actionDisabled = !canActOnTarget || !data?.is_member

  return (
    <aside className="moderator-panel">
      <header className="moderator-panel-head">
        <Avatar
          name={target.username}
          color={target.avatar_color}
          image={target.avatar_image}
          size={44}
          userId={target.id}
          showStatus
        />
        <div className="moderator-panel-identity">
          <span className="moderator-panel-name">{target.username}</span>
          {data?.server_nickname && (
            <span className="moderator-panel-sub">{data.server_nickname}</span>
          )}
        </div>
        <button
          type="button"
          className="moderator-panel-close"
          title="Закрыть панель"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      {/* Ряд действий — то же, что делает контекстное меню, но под рукой,
          пока досье открыто. «Предупреждения» пока заглушка: системы
          предупреждений в проекте нет, и кнопка честно об этом говорит,
          а не притворяется рабочей. */}
      <div className="moderator-panel-actions">
        <button type="button" title="Написать сообщение" onClick={onSendMessage}>
          <MessageSquare size={18} />
        </button>
        <button
          type="button"
          title={
            !canManageMembers
              ? 'Нужно право «Выгонять участников»'
              : actionDisabled
                ? 'Нельзя выгнать участника не ниже вас'
                : 'Выгнать с сервера'
          }
          disabled={!canManageMembers || actionDisabled}
          // Перечитываем сводку сразу после кика: он тут же появляется в
          // журнале аудита прямо под кнопкой, которой его сделали.
          onClick={() => void (async () => {
            await onKick()
            void load()
          })()}
        >
          <UserMinus size={18} />
        </button>
        <button
          type="button"
          title={
            !canBan
              ? 'Нужно право «Банить участников»'
              : !canActOnTarget
                ? 'Нельзя забанить участника не ниже вас'
                : 'Забанить'
          }
          disabled={!canBan || !canActOnTarget}
          onClick={() => void onBan()}
        >
          <Gavel size={18} />
        </button>
        <button type="button" title="Предупреждения — пока не реализованы" disabled>
          <BadgeAlert size={18} />
        </button>
        <button
          type="button"
          className={copied ? 'moderator-panel-copied' : ''}
          title={copied ? 'ID скопирован' : 'Скопировать ID участника'}
          onClick={() => void copyId()}
        >
          <Hash size={18} />
        </button>
      </div>

      <div className="moderator-panel-body">
        <div className="moderator-panel-title">
          <Shield size={14} /> Доступ модератора
          <button
            type="button"
            className="moderator-panel-refresh"
            title="Обновить сводку"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>

        {loading && !data && (
          <div className="moderator-panel-placeholder">
            <Loader2 size={18} className="spin" /> Загружаем сводку…
          </div>
        )}
        {error && <div className="moderator-panel-error">{error}</div>}

        {data && (
          <>
            <div className="moderator-panel-section-label">Активность сервера</div>
            <div className="moderator-panel-card">
              <div className="moderator-panel-row">
                <span><MessageSquare size={14} /> Сообщения</span>
                <span className="moderator-panel-value">
                  {data.stats.messages} <ChevronRight size={14} />
                </span>
              </div>
              <div className="moderator-panel-row">
                <span><LinkIcon size={14} /> Ссылки</span>
                <span className="moderator-panel-value">{data.stats.links}</span>
              </div>
              <div className="moderator-panel-row">
                <span><FileImage size={14} /> Медиаконтент</span>
                <span className="moderator-panel-value">{data.stats.media}</span>
              </div>
              <div className="moderator-panel-row">
                <span><ScrollText size={14} /> Журнал аудита</span>
                <span className="moderator-panel-value">{data.stats.audit_entries}</span>
              </div>
            </div>

            <div className="moderator-panel-section-label">
              Права для модератора
              <span className="moderator-panel-count">
                {grantedPermissions.length === Object.keys(data.permissions).length
                  ? `ВСЕ (${grantedPermissions.length})`
                  : `${grantedPermissions.length} из ${Object.keys(data.permissions).length}`}
              </span>
            </div>
            <div className="moderator-panel-card moderator-panel-perms">
              {grantedPermissions.length === 0 ? (
                <span className="moderator-panel-empty">Прав нет</span>
              ) : (
                grantedPermissions.map(([name]) => (
                  <span key={name} className="moderator-panel-perm">
                    {data.permission_labels[name] ?? name}
                  </span>
                ))
              )}
            </div>

            <div className="moderator-panel-section-label">Роли</div>
            <div className="moderator-panel-card moderator-panel-roles">
              {memberRoles.length === 0 ? (
                <span className="moderator-panel-empty">Ролей нет</span>
              ) : (
                memberRoles.map((r) => (
                  <span key={r.id} className="moderator-panel-role">
                    <span className="srv-role-dot" style={{ background: r.color }} />
                    {r.name}
                  </span>
                ))
              )}
            </div>

            <div className="moderator-panel-section-label">Учётная запись</div>
            <div className="moderator-panel-card">
              <div className="moderator-panel-row">
                <span><UserRound size={14} /> Дата регистрации</span>
                <span className="moderator-panel-value">
                  {formatDate(data.registered_at)}
                </span>
              </div>
              {data.joined_at && (
                <div className="moderator-panel-row">
                  <span><UserRound size={14} /> Присоединился к серверу</span>
                  <span className="moderator-panel-value">
                    {formatDate(data.joined_at)}
                  </span>
                </div>
              )}
              <div className="moderator-panel-row moderator-panel-row-stacked">
                <span>Способ вступления</span>
                <span className="moderator-panel-value">
                  {data.join_invite_code ? (
                    <span className="moderator-panel-code">
                      <LinkIcon size={12} /> {data.join_invite_code}
                    </span>
                  ) : (
                    JOIN_METHOD_LABEL[data.join_method ?? 'unknown']
                  )}
                </span>
                {data.join_invited_by && (
                  <span className="moderator-panel-invited-by">
                    Участник приглашён{' '}
                    <b>{data.join_invited_by.username}</b>
                  </span>
                )}
              </div>
            </div>

            <div className="moderator-panel-section-label">Журнал аудита</div>
            <div className="moderator-panel-card">
              {data.audit_log.length === 0 ? (
                <span className="moderator-panel-empty">Событий пока нет</span>
              ) : (
                data.audit_log.map((entry) => {
                  const detail = auditDetail(entry)
                  return (
                    <div key={entry.id} className="moderator-panel-audit">
                      <div className="moderator-panel-audit-head">
                        <span className="moderator-panel-audit-action">
                          {ACTION_LABEL[entry.action]}
                        </span>
                        <span className="moderator-panel-audit-date">
                          {formatDate(entry.created_at)}
                        </span>
                      </div>
                      {detail && (
                        <span className="moderator-panel-audit-detail">{detail}</span>
                      )}
                      {entry.actor && entry.actor.id !== target.id && (
                        <span className="moderator-panel-audit-actor">
                          {entry.actor.username}
                        </span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
