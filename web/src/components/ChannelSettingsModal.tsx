import { useEffect, useRef, useState } from 'react'
import {
  Bold, Eye, EyeOff, Hash, Italic, Lock, Smile, Strikethrough, Timer, Trash2, Underline,
  UserMinus, Volume2, X,
} from 'lucide-react'
import {
  api, Channel, ChannelInviteEntry, Member, Role,
} from '../api'
import { useEscToClose } from '../modalStack'
import { renderSimpleMarkdown } from '../markdown'
import Avatar from './Avatar'
import EmojiPicker, { EmojiPickerAnchor } from './EmojiPicker'
import ToggleSwitch from './ToggleSwitch'

type TabId = 'overview' | 'access' | 'invites'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Обзор' },
  { id: 'access', label: 'Права доступа' },
  { id: 'invites', label: 'Приглашения' },
]

/** Те же ступени, что раньше были кнопками прямо в ChannelContextMenu —
 * здесь список select'а (см. Обзор), сама шкала не изменилась. */
const SLOWMODE_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'Выкл.' },
  { value: 5, label: '5 секунд' },
  { value: 10, label: '10 секунд' },
  { value: 15, label: '15 секунд' },
  { value: 30, label: '30 секунд' },
  { value: 60, label: '1 минута' },
  { value: 300, label: '5 минут' },
  { value: 900, label: '15 минут' },
  { value: 3600, label: '1 час' },
  { value: 21600, label: '6 часов' },
]

/**
 * «Настроить канал» — правый клик по каналу → «Настроить канал» (только с
 * manage_channels, см. ChannelContextMenu). Оболочка — та же .settings-modal
 * (сайдбар + контент), что и у SettingsModal/ServerSettingsModal, просто с
 * тремя вкладками вместо длинного списка категорий.
 *
 * Каждое поле сохраняется само по себе, сразу по изменению (select/toggle/
 * radio) или по уходу с поля (name/topic — иначе на каждую букву уходил бы
 * PATCH) — тот же принцип, что был у старого инлайн-меню, просто разложенный
 * по вкладкам. Отдельного черновика с кнопкой «Сохранить» здесь намеренно
 * нет: полей мало, и ни одно не требует явного подтверждения перед отправкой.
 */
export default function ChannelSettingsModal({
  channel,
  roles,
  members,
  onClose,
  onRenamed,
  onSetStatus,
  onSetSlowmode,
  onSetVisibility,
  onSetPrivacy,
  onSetInvitesPaused,
  onDelete,
}: {
  channel: Channel
  roles: Role[]
  members: Member[]
  onClose: () => void
  onRenamed: (name: string) => void
  onSetStatus: (status: string) => void
  onSetSlowmode: (seconds: number) => void
  onSetVisibility: (mode: 'default' | 'spoiler' | 'age_restricted') => void
  onSetPrivacy: (isPrivate: boolean, allowedRoleIds: number[], allowedUserIds: number[]) => void
  onSetInvitesPaused: (paused: boolean) => void
  onDelete: () => void
}) {
  useEscToClose(onClose)
  const [tab, setTab] = useState<TabId>('overview')
  const isVoice = channel.kind === 'voice'

  return (
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div
        className="modal settings-modal channel-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="channel-settings-close" onClick={onClose} title="Закрыть">
          <span className="channel-settings-close-circle"><X size={18} /></span>
          <span className="channel-settings-close-label">ESC</span>
        </button>

        <div className="settings-body">
          <nav className="settings-sidebar channel-settings-sidebar">
            <div className="channel-settings-header">
              <span className="channel-settings-name">
                {isVoice ? <Volume2 size={15} /> : <Hash size={15} />} {channel.name}
              </span>
              <span className="channel-settings-kind">
                {isVoice ? 'Голосовой канал' : 'Текстовый канал'}
              </span>
            </div>

            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`settings-sidebar-item ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}

            <div className="settings-sidebar-pinned">
              <button type="button" className="settings-sidebar-item danger" onClick={onDelete}>
                Удалить канал <Trash2 size={15} />
              </button>
            </div>
          </nav>

          <div className="settings-content channel-settings-content">
            <h2 className="channel-settings-content-title">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            {tab === 'overview' && (
              <OverviewTab
                channel={channel}
                onRenamed={onRenamed}
                onSetStatus={onSetStatus}
                onSetSlowmode={onSetSlowmode}
                onSetVisibility={onSetVisibility}
              />
            )}
            {tab === 'access' && (
              <AccessTab
                channel={channel}
                roles={roles}
                members={members}
                onSetPrivacy={onSetPrivacy}
              />
            )}
            {tab === 'invites' && (
              <InvitesTab channel={channel} onSetInvitesPaused={onSetInvitesPaused} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Токен-маркер тулбара темы: (marker, чем оборачивать выделение). Порядок —
 * тот же, что в web/src/markdown.ts (renderSimpleMarkdown должен понимать
 * ровно то, что здесь вставляется). */
const TOPIC_TOOLBAR: { marker: string; label: string; Icon: typeof Bold }[] = [
  { marker: '**', label: 'Жирный', Icon: Bold },
  { marker: '*', label: 'Курсив', Icon: Italic },
  { marker: '__', label: 'Подчёркнутый', Icon: Underline },
  { marker: '~~', label: 'Зачёркнутый', Icon: Strikethrough },
]

function OverviewTab({
  channel,
  onRenamed,
  onSetStatus,
  onSetSlowmode,
  onSetVisibility,
}: {
  channel: Channel
  onRenamed: (name: string) => void
  onSetStatus: (status: string) => void
  onSetSlowmode: (seconds: number) => void
  onSetVisibility: (mode: 'default' | 'spoiler' | 'age_restricted') => void
}) {
  // Локальный черновик только для полей, которые сохраняются по blur (имя,
  // тема) — набирать текст, отправляя PATCH на каждую букву, было бы и
  // расточительно, и просто медленно на глаз. select/radio ниже применяются
  // сразу и черновика не требуют.
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.status)
  const [topicPreview, setTopicPreview] = useState(false)
  const [emojiAnchor, setEmojiAnchor] = useState<EmojiPickerAnchor | null>(null)
  const topicRef = useRef<HTMLTextAreaElement>(null)
  // Канал могли переключить, пока модалка открыта (правый клик по другому
  // каналу без закрытия этой — редкий, но возможный путь) — синхронизируем
  // черновик с новым каналом, а не дописываем поверх чужого имени.
  useEffect(() => {
    setName(channel.name)
    setTopic(channel.status)
    setTopicPreview(false)
  }, [channel.id, channel.name, channel.status])

  const commitName = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setName(channel.name)
      return
    }
    if (trimmed !== channel.name) onRenamed(trimmed)
  }

  const commitTopic = () => {
    if (topic !== channel.status) onSetStatus(topic)
  }

  // Оборачивает текущее выделение в textarea маркером разметки. Кнопки
  // тулбара гасят mousedown (preventDefault) — иначе клик по кнопке сначала
  // снял бы фокус с textarea (blur → commitTopic отправил бы ещё не
  // изменённый черновик) и потерял бы selectionStart/End.
  const wrapSelection = (marker: string) => {
    const el = topicRef.current
    if (!el) return
    const start = el.selectionStart ?? topic.length
    const end = el.selectionEnd ?? topic.length
    const next = `${topic.slice(0, start)}${marker}${topic.slice(start, end)}${marker}${topic.slice(end)}`
    setTopic(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + marker.length, end + marker.length)
    })
  }

  const insertAtCursor = (text: string) => {
    const el = topicRef.current
    const pos = el?.selectionStart ?? topic.length
    const next = `${topic.slice(0, pos)}${text}${topic.slice(pos)}`
    setTopic(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos + text.length, pos + text.length)
    })
  }

  const visibility: 'default' | 'spoiler' | 'age_restricted' = channel.is_spoiler
    ? 'spoiler'
    : channel.age_restricted
      ? 'age_restricted'
      : 'default'

  return (
    <div className="channel-settings-tab">
      <label className="settings-field">
        <span className="settings-field-label">Название канала</span>
        <input
          className="field-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          maxLength={100}
        />
      </label>

      {channel.kind === 'text' && (
        <div className="settings-field">
          <span className="settings-field-label">Тема канала</span>

          <div className="channel-settings-topic-toolbar">
            {TOPIC_TOOLBAR.map(({ marker, label, Icon }) => (
              <button
                key={marker}
                type="button"
                title={label}
                disabled={topicPreview}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => wrapSelection(marker)}
              >
                <Icon size={15} />
              </button>
            ))}
            <button
              type="button"
              title="Эмодзи"
              disabled={topicPreview}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) =>
                setEmojiAnchor((prev) =>
                  prev
                    ? null
                    : { rect: e.currentTarget.getBoundingClientRect(), placement: 'below' },
                )
              }
            >
              <Smile size={15} />
            </button>
            <div className="channel-settings-topic-toolbar-spacer" />
            <button
              type="button"
              title={topicPreview ? 'Редактировать' : 'Предпросмотр'}
              className={topicPreview ? 'active' : ''}
              onClick={() => setTopicPreview((p) => !p)}
            >
              {topicPreview ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {topicPreview ? (
            <div className="field-input channel-settings-topic channel-settings-topic-preview">
              {topic
                ? renderSimpleMarkdown(topic, 'channel-topic-preview')
                : (
                  <span className="channel-settings-topic-placeholder">
                    Расскажите участникам, как пользоваться этим каналом
                  </span>
                )}
            </div>
          ) : (
            <textarea
              ref={topicRef}
              className="field-input channel-settings-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onBlur={commitTopic}
              maxLength={1024}
              rows={4}
              placeholder="Расскажите участникам, как пользоваться этим каналом"
            />
          )}
          <span className="channel-settings-topic-count">{topic.length}/1024</span>
          <p className="srv-hint">
            Показывается в шапке канала рядом с его названием. Поддерживает **жирный**,
            *курсив*, __подчёркнутый__ и ~~зачёркнутый~~.
          </p>

          {emojiAnchor && (
            <EmojiPicker
              anchor={emojiAnchor}
              onPick={(emoji) => insertAtCursor(emoji)}
              onClose={() => setEmojiAnchor(null)}
            />
          )}
        </div>
      )}

      {channel.kind === 'text' && (
        <label className="settings-field">
          <span className="settings-field-label">
            <Timer size={14} /> Медленный режим
          </span>
          <select
            className="field-input"
            value={channel.slowmode_seconds}
            onChange={(e) => onSetSlowmode(Number(e.target.value))}
          >
            {SLOWMODE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="srv-hint">
            Участники не смогут отправлять сообщения чаще этого интервала — кроме тех, у кого
            есть право обходить медленный режим.
          </p>
        </label>
      )}

      {channel.kind === 'text' && (
        <div className="settings-field">
          <span className="settings-field-label">Видимость контента</span>
          <label className="channel-settings-radio">
            <input
              type="radio"
              name="channel-visibility"
              checked={visibility === 'default'}
              onChange={() => onSetVisibility('default')}
            />
            <span className="channel-settings-radio-text">
              <b>По умолчанию</b>
              <small>Контент канала всегда виден.</small>
            </span>
          </label>
          <label className="channel-settings-radio">
            <input
              type="radio"
              name="channel-visibility"
              checked={visibility === 'spoiler'}
              onChange={() => onSetVisibility('spoiler')}
            />
            <span className="channel-settings-radio-text">
              <b>Канал со спойлерами</b>
              <small>
                При переходе в канал участники сначала увидят предупреждение о чувствительном
                содержимом.
              </small>
            </span>
          </label>
          <label className="channel-settings-radio">
            <input
              type="radio"
              name="channel-visibility"
              checked={visibility === 'age_restricted'}
              onChange={() => onSetVisibility('age_restricted')}
            />
            <span className="channel-settings-radio-text">
              <b>Канал с возрастным ограничением</b>
              <small>
                Помечает канал как содержащий контент 18+. Само ограничение доступа появится
                позже — пока это только отметка.
              </small>
            </span>
          </label>
        </div>
      )}
    </div>
  )
}

function AccessTab({
  channel,
  roles,
  members,
  onSetPrivacy,
}: {
  channel: Channel
  roles: Role[]
  members: Member[]
  onSetPrivacy: (isPrivate: boolean, allowedRoleIds: number[], allowedUserIds: number[]) => void
}) {
  // Роль по умолчанию есть у всех — «открыть ей приватный канал» означало бы
  // сделать его публичным окольным путём, поэтому в список не попадает (тот
  // же приём, что был в старом инлайн-меню).
  const assignableRoles = roles.filter((r) => !r.is_default)

  const toggleRole = (roleId: number) => {
    const allowed = channel.allowed_role_ids.includes(roleId)
    onSetPrivacy(
      true,
      allowed
        ? channel.allowed_role_ids.filter((id) => id !== roleId)
        : [...channel.allowed_role_ids, roleId],
      channel.allowed_user_ids,
    )
  }

  const toggleUser = (userId: number) => {
    const allowed = channel.allowed_user_ids.includes(userId)
    onSetPrivacy(
      true,
      channel.allowed_role_ids,
      allowed
        ? channel.allowed_user_ids.filter((id) => id !== userId)
        : [...channel.allowed_user_ids, userId],
    )
  }

  // «Кто сейчас видит канал» — объединение персонально допущенных и тех, у
  // кого подходящая роль. Снять напрямую можно только персональный допуск
  // (см. докстринг Channel.allowed_users на бэке) — у пришедших по роли
  // кнопки «Снять» нет: убрать им доступ значит забрать роль, а это уже
  // редактор ролей, не эта вкладка.
  const roleViewerIds = new Set(
    members
      .filter((m) => m.role_ids.some((rid) => channel.allowed_role_ids.includes(rid)))
      .map((m) => m.id),
  )
  const directViewerIds = new Set(channel.allowed_user_ids)
  const viewers = members.filter((m) => roleViewerIds.has(m.id) || directViewerIds.has(m.id))

  return (
    <div className="channel-settings-tab">
      <div className="settings-field">
        <div className="settings-field-header">
          <span className="settings-field-label">
            <Lock size={14} /> Приватный канал
          </span>
          <ToggleSwitch
            checked={channel.is_private}
            onChange={(v) => onSetPrivacy(v, channel.allowed_role_ids, channel.allowed_user_ids)}
            ariaLabel="Приватный канал"
          />
        </div>
        <p className="srv-hint">
          Канал видят управляющие каналами и те, кому явно открыт доступ ниже — ролью,
          участником или тем и другим сразу.
        </p>
      </div>

      {channel.is_private && (
        <>
          <div className="settings-field">
            <span className="settings-field-label">Роли с доступом</span>
            {assignableRoles.length === 0 ? (
              <p className="srv-hint">
                На сервере пока нет ролей, кроме роли по умолчанию.
              </p>
            ) : (
              <div className="channel-settings-checklist">
                {assignableRoles.map((role) => (
                  <label key={role.id} className="server-flyout-checkbox">
                    <input
                      type="checkbox"
                      checked={channel.allowed_role_ids.includes(role.id)}
                      onChange={() => toggleRole(role.id)}
                    />
                    <span className="srv-role-dot" style={{ background: role.color }} />
                    {role.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="settings-field">
            <span className="settings-field-label">Участники с личным доступом</span>
            <div className="channel-settings-checklist">
              {members.map((m) => (
                <label key={m.id} className="server-flyout-checkbox">
                  <input
                    type="checkbox"
                    checked={channel.allowed_user_ids.includes(m.id)}
                    onChange={() => toggleUser(m.id)}
                  />
                  {m.username}
                </label>
              ))}
            </div>
          </div>

          <div className="settings-field">
            <span className="settings-field-label">Кто сейчас видит канал</span>
            {viewers.length === 0 ? (
              <p className="srv-hint">
                Пока никто, кроме тех, кто управляет каналами.
              </p>
            ) : (
              <div className="channel-settings-viewer-list">
                {viewers.map((m) => (
                  <div key={m.id} className="channel-settings-viewer-row">
                    <Avatar
                      name={m.username}
                      color={m.avatar_color}
                      image={m.avatar_image}
                      size={24}
                      userId={m.id}
                    />
                    <span className="member-name">{m.username}</span>
                    <span className="channel-settings-viewer-via">
                      {directViewerIds.has(m.id) ? 'лично' : 'по роли'}
                    </span>
                    {directViewerIds.has(m.id) && (
                      <button
                        type="button"
                        className="btn-small"
                        title="Снять личный доступ"
                        onClick={() => toggleUser(m.id)}
                      >
                        <UserMinus size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const INVITE_STATUS_LABEL: Record<string, string> = {
  pending: 'Ожидает',
  accepted: 'Принято',
  declined: 'Отклонено',
}

function InvitesTab({
  channel,
  onSetInvitesPaused,
}: {
  channel: Channel
  onSetInvitesPaused: (paused: boolean) => void
}) {
  const [invites, setInvites] = useState<ChannelInviteEntry[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setInvites(null)
    setError('')
    api
      .channelInvites(channel.id)
      .then((list) => {
        if (!cancelled) setInvites(list)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [channel.id])

  return (
    <div className="channel-settings-tab">
      <div className="settings-field">
        <div className="settings-field-header">
          <span className="settings-field-label">Приостановить приглашения</span>
          <ToggleSwitch
            checked={channel.invites_paused}
            onChange={onSetInvitesPaused}
            ariaLabel="Приостановить приглашения"
          />
        </div>
        <p className="srv-hint">
          Пока пауза включена, новые личные приглашения в этот канал не заводятся. Уже
          отправленные и решения по ним не затрагивает.
        </p>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Кому отправлены приглашения</span>
        {error && <p className="login-error">{error}</p>}
        {invites === null && !error && <p className="srv-hint">Загрузка…</p>}
        {invites && invites.length === 0 && (
          <p className="srv-hint">Пока никому.</p>
        )}
        {invites && invites.length > 0 && (
          <div className="channel-settings-viewer-list">
            {invites.map((inv) => (
              <div key={inv.id} className="channel-settings-viewer-row">
                <Avatar
                  name={inv.invited_user.username}
                  color={inv.invited_user.avatar_color}
                  image={inv.invited_user.avatar_image}
                  size={24}
                  userId={inv.invited_user.id}
                />
                <span className="member-name">{inv.invited_user.username}</span>
                <span className={`channel-settings-invite-status ${inv.status}`}>
                  {INVITE_STATUS_LABEL[inv.status] ?? inv.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
