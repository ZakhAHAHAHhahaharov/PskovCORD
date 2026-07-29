import { useEffect, useRef, useState, ChangeEvent } from 'react'
import {
  Camera, Check, ChevronLeft, ChevronRight, Crown, Loader2, Plus, Shield,
  ShieldBan, SlidersHorizontal, Trash2, UserRoundCheck, X,
} from 'lucide-react'
import {
  api, Member, Role, Server, ServerAccessMode, ServerBanEntry,
  ServerJoinRequestEntry, ServerPermission, ServerRule,
} from '../api'
import {
  BANNER_MAX_BYTES, BANNER_MAX_H, BANNER_MAX_W, GRADIENT_PRESETS,
  SERVER_ICON_SIZE, buildGradient, fileToBannerDataUrl, fileToSquareDataUrl,
  parseGradient,
} from '../images'
import { useEscToClose } from '../modalStack'
import Avatar from './Avatar'

type TabId = 'profile' | 'roles' | 'requests' | 'access' | 'bans'

interface TabDef {
  id: TabId
  label: string
  icon: React.ReactNode
  /** Право, без которого вкладку не видно вообще. */
  permission: ServerPermission
}

const TABS: TabDef[] = [
  { id: 'profile', label: 'Профиль', icon: <SlidersHorizontal size={15} />, permission: 'manage_server' },
  { id: 'roles', label: 'Роли', icon: <Shield size={15} />, permission: 'manage_roles' },
  { id: 'requests', label: 'Запросы', icon: <UserRoundCheck size={15} />, permission: 'manage_members' },
  { id: 'access', label: 'Доступ', icon: <Check size={15} />, permission: 'manage_server' },
  { id: 'bans', label: 'ЧС списочек xD', icon: <ShieldBan size={15} />, permission: 'manage_members' },
]

/** Группы прав в редакторе роли — порядок и подписи повторяют
 * chat/roles.py PERMISSION_FIELDS (там же список полей модели). */
const PERMISSION_GROUPS: { title: string; items: [ServerPermission, string][] }[] = [
  {
    title: 'Общие права сервера',
    items: [
      ['view_channels', 'Просматривать каналы'],
      ['manage_channels', 'Управлять каналами'],
      ['manage_roles', 'Управлять ролями'],
      ['manage_server', 'Управлять сервером'],
      // manage_invites / manage_nicknames отсюда убраны: они охраняли фичи,
      // которых в проекте нет, и были переключателями, не делавшими ничего.
      // Вернутся вместе с самими фичами — см. chat/roles.py.
      ['manage_members', 'Выгонять / одобрять / банить участников'],
    ],
  },
  {
    title: 'Текстовые каналы',
    items: [
      ['send_messages', 'Отправка сообщений'],
      ['delete_messages', 'Удаление сообщений'],
      // mention_everyone — там же: разбора @all/@online/@here нет нигде.
    ],
  },
  {
    title: 'Голосовые каналы',
    items: [
      ['speak', 'Говорить'],
      ['video', 'Показывать видео'],
    ],
  },
]

const PERMISSION_LABELS: Record<string, string> = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((g) => g.items),
)

/** Права, которые нельзя снять с роли "Владелец" — см. одноимённую
 * backend-константу chat.roles.OWNER_LOCKED_PERMISSIONS: без них владелец
 * потерял бы доступ к настройкам/ролям собственного сервера навсегда,
 * заступиться некому (он и так уже выше всех в иерархии). Бэк форсит их в
 * True при любом PATCH независимо от этого списка — здесь чисто чтобы не
 * дать пользователю щёлкнуть чекбокс, которому бэк всё равно не даст сработать. */
const OWNER_LOCKED_PERMISSIONS = new Set<ServerPermission>(['manage_server', 'manage_roles'])

/** Держит ли ЭТО право хоть кто-то на сервере, кроме самого владельца —
 * через роль по умолчанию или любую персональную роль. Используется только
 * когда владелец снимает право с САМОГО СЕБЯ (роль "Владелец") — предупредить,
 * что после этого право не сможет применить уже никто. */
function permissionHeldByAnyoneElse(
  permission: ServerPermission,
  roles: Role[],
  members: Member[],
): boolean {
  const defaultRole = roles.find((r) => r.is_default)
  if (defaultRole?.[permission]) return true
  return members.some((m) => {
    if (m.is_owner) return false
    return m.role_ids.some((rid) => roles.find((r) => r.id === rid)?.[permission])
  })
}

const ACCESS_MODES: { value: ServerAccessMode; label: string; hint: string }[] = [
  { value: 'invite', label: 'Только по приглашению', hint: 'Вступить через поиск серверов нельзя.' },
  { value: 'request', label: 'По заявке', hint: 'Заявки приходят во вкладку «Запросы».' },
  { value: 'public', label: 'Публичный', hint: 'Любой может вступить из поиска серверов.' },
]

function Toggle({
  checked,
  label,
  hint,
  disabled,
  onChange,
}: {
  checked: boolean
  label: string
  hint?: string
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className={`srv-toggle ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="srv-toggle-text">
        <span className="srv-toggle-label">{label}</span>
        {hint && <span className="srv-toggle-hint">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * Редактор сервера — та же оболочка, что и у настроек пользователя
 * (SettingsModal): .modal-overlay + .modal.settings-modal, заголовок, слева
 * колонка разделов, справа скроллящееся содержимое. Раньше это была своя
 * полноэкранная панель с горизонтальным рядом вкладок — два визуально разных
 * «окна настроек» в одном приложении.
 *
 * Разделы показываются только те, на которые у текущего пользователя есть
 * права (см. Server.my_permissions, они же считаются на бэке в chat/roles.py —
 * прятать кнопки без серверной проверки нельзя).
 */
export default function ServerSettingsModal({
  server,
  members,
  onClose,
  onServerUpdated,
  onMembersChanged,
  onRolesChanged,
  isMobile,
}: {
  server: Server
  members: Member[]
  onClose: () => void
  onServerUpdated: (s: Server) => void
  /** Список участников менялся (роли/кик/бан) — попросить AppShell перезагрузить. */
  onMembersChanged: () => void
  /** Роль создана/изменена/удалена — попросить AppShell перечитать роли
   * сервера (см. AppShell.reloadRoles): иначе MembersList в правом сайдбаре
   * (группировка/цвет/имя роли) видел бы старые данные до смены сервера. */
  onRolesChanged: () => void
  /** На мобилке — список вкладок и содержимое активной вкладки два разных
   * полных "экрана" (тап по вкладке открывает её на весь экран, кнопка
   * назад закрывает ТОЛЬКО её), а не таб-строка сверху и контент под ней
   * сразу оба видны, как на ПК. Тот же приём, что у SettingsModal.tsx
   * (mobileCategoryOpen) — тут название второй раз лишь потому, что
   * вкладки редактора сервера называются "вкладками", а не "категориями". */
  isMobile?: boolean
}) {
  const perms = server.my_permissions
  // «Запросы» имеют смысл только там, где заявки вообще появляются: сервер
  // принимает по заявке или закрыт приватностью.
  const requestsRelevant = server.access_mode === 'request' || server.is_private
  const availableTabs = TABS.filter(
    (t) => perms[t.permission] && (t.id !== 'requests' || requestsRelevant),
  )
  const [tab, setTab] = useState<TabId>(availableTabs[0]?.id ?? 'profile')
  const [mobileTabOpen, setMobileTabOpen] = useState(false)
  const currentTab = availableTabs.find((t) => t.id === tab)

  // Esc закрывает редактор — он занимает весь экран, кликать мимо неудобно.
  // Общий стек модалок (см. modalStack.ts): если поверх редактора открыто
  // что-то ещё (например, мини-профиль), Esc сначала закроет ЕГО, а не оба разом.
  useEscToClose(onClose)

  return (
    // settings-overlay — та же полноэкранная мобильная раскладка, что и у
    // личных настроек (см. .settings-overlay в index.css): без неё
    // .server-settings-modal на мобилке остался бы узкой центрированной
    // модалкой (её 860px десктопной ширины клампит только базовый
    // .modal{max-width:92vw}), а внутренний mobile-category-open toggle
    // (список вкладок ↔ контент вкладки) рассчитан ровно на полный экран.
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div
        className="modal settings-modal server-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title settings-modal-title">
          {isMobile && (
            <button
              className="chat-back-btn"
              title="Назад"
              onClick={() => (mobileTabOpen ? setMobileTabOpen(false) : onClose())}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          {isMobile && mobileTabOpen ? (
            <span className="settings-modal-title-text">{currentTab?.label}</span>
          ) : (
            <>
              <Avatar name={server.name} color="#5865f2" image={server.icon} size={26} />
              <span className="settings-modal-title-text">Настройки сервера — {server.name}</span>
            </>
          )}
        </h2>

        <div className={`settings-body${isMobile && mobileTabOpen ? ' mobile-category-open' : ''}`}>
          <nav className="settings-sidebar">
            {availableTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`settings-sidebar-item${tab === t.id ? ' active' : ''}`}
                onClick={() => {
                  setTab(t.id)
                  if (isMobile) setMobileTabOpen(true)
                }}
              >
                {t.icon} {t.label}
                {isMobile && <ChevronRight size={15} className="settings-row-chevron" />}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {availableTabs.length === 0 && (
              <div className="modal-empty">Нет прав на настройку этого сервера.</div>
            )}
            {tab === 'profile' && (
              <ProfileTab server={server} onServerUpdated={onServerUpdated} />
            )}
            {tab === 'roles' && (
              <RolesTab
                server={server}
                members={members}
                onMembersChanged={onMembersChanged}
                onRolesChanged={onRolesChanged}
              />
            )}
            {tab === 'requests' && (
              <RequestsTab server={server} onMembersChanged={onMembersChanged} />
            )}
            {tab === 'access' && <AccessTab server={server} onServerUpdated={onServerUpdated} />}
            {tab === 'bans' && (
              <BansTab server={server} members={members} onMembersChanged={onMembersChanged} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- 1. Профиль сервера ---------------------------------------------------

function ProfileTab({
  server,
  onServerUpdated,
}: {
  server: Server
  onServerUpdated: (s: Server) => void
}) {
  const iconFileRef = useRef<HTMLInputElement>(null)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState(server.name)
  const [icon, setIcon] = useState(server.icon)
  const [description, setDescription] = useState(server.description)
  const [tags, setTags] = useState<string[]>(server.tags)
  const [tagDraft, setTagDraft] = useState('')
  const [isPrivate, setIsPrivate] = useState(server.is_private)

  const initial = parseGradient(server.banner_gradient)
  const [bannerMode, setBannerMode] = useState<'gradient' | 'gif'>(
    server.banner_image ? 'gif' : 'gradient',
  )
  const [gradientFrom, setGradientFrom] = useState(initial.from)
  const [gradientTo, setGradientTo] = useState(initial.to)
  const [gradientAngle, setGradientAngle] = useState(initial.angle)
  const [bannerImage, setBannerImage] = useState(server.banner_image)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const gradientCss = buildGradient(gradientAngle, gradientFrom, gradientTo)
  const desiredGradient = bannerMode === 'gradient' ? gradientCss : ''
  const desiredBannerImage = bannerMode === 'gif' ? bannerImage : ''

  const touch = () => setSaved(false)

  const handleIconFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    touch()
    try {
      setIcon(await fileToSquareDataUrl(file, SERVER_ICON_SIZE))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleBannerFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    touch()
    try {
      setBannerImage(await fileToBannerDataUrl(file))
      setBannerMode('gif')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const addTag = () => {
    const trimmed = tagDraft.trim()
    if (!trimmed || tags.includes(trimmed)) {
      setTagDraft('')
      return
    }
    setTags([...tags, trimmed])
    setTagDraft('')
    touch()
  }

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Имя сервера не может быть пустым.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateServer(server.id, {
        name: name.trim(),
        icon,
        description,
        tags,
        is_private: isPrivate,
        banner_gradient: desiredGradient,
        banner_image: desiredBannerImage,
      })
      onServerUpdated(updated)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="srv-tab">
      <div className="srv-icon-row">
        <button
          type="button"
          className="profile-avatar-edit"
          title="Сменить значок сервера"
          onClick={() => iconFileRef.current?.click()}
        >
          <Avatar name={name || server.name} color="#5865f2" image={icon} size={80} />
          <span className="profile-avatar-overlay">
            <Camera size={20} />
          </span>
        </button>
        <input
          ref={iconFileRef}
          type="file"
          accept="image/*"
          className="profile-file-input"
          onChange={handleIconFile}
        />
        <div className="srv-icon-hint">
          Значок виден в списке серверов слева. Картинка обрезается по центру и
          сжимается до {SERVER_ICON_SIZE}×{SERVER_ICON_SIZE}.
          {icon && (
            <button
              type="button"
              className="profile-avatar-remove"
              onClick={() => {
                setIcon('')
                touch()
              }}
            >
              <Trash2 size={13} /> Удалить значок
            </button>
          )}
        </div>
      </div>

      <div className="field-label">Имя сервера</div>
      <input
        className="field-input"
        value={name}
        maxLength={100}
        onChange={(e) => {
          setName(e.target.value)
          touch()
        }}
      />

      <div className="field-label">Баннер сервера</div>
      <div
        className="banner-preview"
        style={{ background: bannerMode === 'gif' && bannerImage ? undefined : gradientCss }}
      >
        {bannerMode === 'gif' && bannerImage && (
          <img src={bannerImage} alt="" className="banner-preview-img" />
        )}
      </div>
      <div className="banner-mode-tabs">
        <button
          type="button"
          className={`banner-mode-tab ${bannerMode === 'gradient' ? 'active' : ''}`}
          onClick={() => {
            setBannerMode('gradient')
            touch()
          }}
        >
          Градиент
        </button>
        <button
          type="button"
          className={`banner-mode-tab ${bannerMode === 'gif' ? 'active' : ''}`}
          onClick={() => {
            setBannerMode('gif')
            touch()
          }}
        >
          Гифка
        </button>
      </div>

      {bannerMode === 'gradient' ? (
        <>
          <div className="gradient-presets">
            {GRADIENT_PRESETS.map(([from, to]) => (
              <button
                key={from + to}
                type="button"
                className="gradient-preset"
                style={{ background: buildGradient(gradientAngle, from, to) }}
                title="Применить пресет"
                onClick={() => {
                  setGradientFrom(from)
                  setGradientTo(to)
                  touch()
                }}
              />
            ))}
          </div>
          <div className="gradient-controls">
            <label className="gradient-color-field">
              От
              <input
                type="color"
                value={gradientFrom}
                onChange={(e) => {
                  setGradientFrom(e.target.value)
                  touch()
                }}
              />
            </label>
            <label className="gradient-color-field">
              До
              <input
                type="color"
                value={gradientTo}
                onChange={(e) => {
                  setGradientTo(e.target.value)
                  touch()
                }}
              />
            </label>
            <label className="gradient-angle-field">
              Угол
              <input
                type="range"
                min={0}
                max={360}
                value={gradientAngle}
                onChange={(e) => {
                  setGradientAngle(Number(e.target.value))
                  touch()
                }}
              />
            </label>
          </div>
        </>
      ) : (
        <div className="banner-gif-row">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => bannerFileRef.current?.click()}
          >
            {bannerImage ? 'Заменить гифку' : 'Загрузить гифку'}
          </button>
          <input
            ref={bannerFileRef}
            type="file"
            accept="image/gif,image/webp,image/png,image/jpeg"
            className="profile-file-input"
            onChange={handleBannerFile}
          />
          {bannerImage && (
            <button
              type="button"
              className="profile-avatar-remove"
              onClick={() => {
                setBannerImage('')
                touch()
              }}
            >
              <Trash2 size={13} /> Убрать
            </button>
          )}
          <span className="banner-hint">
            До {BANNER_MAX_W}×{BANNER_MAX_H}, макс. {Math.round(BANNER_MAX_BYTES / 1_000_000)} МБ.
          </span>
        </div>
      )}

      <div className="field-label">Особенности</div>
      <div className="srv-tags">
        {tags.map((t) => (
          <span key={t} className="srv-tag">
            {t}
            <button
              type="button"
              title="Убрать особенность"
              onClick={() => {
                setTags(tags.filter((x) => x !== t))
                touch()
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {tags.length === 0 && <span className="srv-hint">Пока пусто.</span>}
      </div>
      <div className="srv-inline-add">
        <input
          className="field-input"
          value={tagDraft}
          maxLength={32}
          placeholder="Например: игры, аниме, 18+, посиделки"
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
        />
        <button type="button" className="btn-secondary" onClick={addTag}>
          <Plus size={14} /> Добавить
        </button>
      </div>
      <p className="srv-hint">
        Показываются в поиске серверов и в подсказке при наведении на сервер.
      </p>

      <div className="field-label">Описание сервера</div>
      <textarea
        className="field-input srv-textarea"
        value={description}
        maxLength={2000}
        rows={4}
        onChange={(e) => {
          setDescription(e.target.value)
          touch()
        }}
      />

      <div className="field-label">Приватность</div>
      <Toggle
        checked={isPrivate}
        label="Приватный сервер"
        hint="Описание, особенности и участников видят только те, кто уже на сервере."
        onChange={(v) => {
          setIsPrivate(v)
          touch()
        }}
      />

      {error && <div className="login-error">{error}</div>}
      {saved && !error && <div className="profile-success">Сохранено.</div>}
      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
      </button>
    </div>
  )
}

// --- 2. Роли --------------------------------------------------------------

function RolesTab({
  server,
  members,
  onMembersChanged,
  onRolesChanged,
}: {
  server: Server
  members: Member[]
  onMembersChanged: () => void
  onRolesChanged: () => void
}) {
  const [roles, setRoles] = useState<Role[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Правка идёт по локальной копии выбранной роли, чтобы чекбоксы отвечали
  // мгновенно, а на сервер уходил один PATCH по кнопке «Сохранить».
  const [draft, setDraft] = useState<Role | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const list = await api.roles(server.id)
        setRoles(list)
        setSelectedId(list[0]?.id ?? null)
        setDraft(list[0] ?? null)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [server.id])

  const select = (role: Role) => {
    setSelectedId(role.id)
    setDraft(role)
    setError('')
  }

  const handleCreate = async () => {
    setError('')
    try {
      const created = await api.createRole(server.id, {
        name: 'Новая роль',
        color: '#5865f2',
        position: roles.length,
      })
      setRoles([created, ...roles])
      select(created)
      onRolesChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleSave = async () => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateRole(server.id, draft.id, draft)
      setRoles(roles.map((r) => (r.id === updated.id ? updated : r)))
      setDraft(updated)
      onRolesChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!draft || draft.is_default) return
    if (!window.confirm(`Удалить роль «${draft.name}»?`)) return
    try {
      await api.deleteRole(server.id, draft.id)
      const rest = roles.filter((r) => r.id !== draft.id)
      setRoles(rest)
      setSelectedId(rest[0]?.id ?? null)
      setDraft(rest[0] ?? null)
      onRolesChanged()
      onMembersChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const toggleMemberRole = async (member: Member, on: boolean) => {
    if (!draft) return
    const next = on
      ? [...member.role_ids, draft.id]
      : member.role_ids.filter((id) => id !== draft.id)
    try {
      await api.setMemberRoles(server.id, member.id, next)
      onMembersChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** Чекбокс на роли "Владелец": manage_server/manage_roles всегда включены
   * (см. backend chat.roles.OWNER_LOCKED_PERMISSIONS — без них владелец
   * потерял бы доступ к собственным настройкам/ролям НАВСЕГДА, заступиться
   * некому). Остальные права снять можно, но если СНЯТИЕ оставит право
   * буквально ни у кого на сервере (кроме самого владельца, который его и
   * снимает), спрашиваем подтверждение — тот самый сценарий, ради которого
   * эта роль вообще редактируемая.
   *
   * window.confirm, а не отдельная модалка: тот же приём, что уже у
   * "Удалить роль" чуть ниже (handleDelete) — здесь это разовое действие
   * внутри формы, а не отдельный поток вроде подтверждения удаления
   * сообщения. */
  const handleTogglePermission = (key: ServerPermission, checked: boolean) => {
    if (!draft) return
    if (draft.is_owner_role) {
      if (OWNER_LOCKED_PERMISSIONS.has(key)) return // чекбокс и так задизейблен
      if (!checked && !permissionHeldByAnyoneElse(key, roles, members)) {
        const label = PERMISSION_LABELS[key] ?? key
        if (
          !window.confirm(
            `Больше ни у кого на сервере не будет права «${label}». Снять его у себя всё равно?`,
          )
        ) {
          return
        }
      }
    }
    setDraft({ ...draft, [key]: checked })
  }

  if (loading) return <div className="modal-empty">Загрузка…</div>

  // Владелец — всегда первым в списке слева, остальной порядок как прислал бэк.
  const sortedRoles = [...roles].sort((a, b) => Number(b.is_owner_role) - Number(a.is_owner_role))

  return (
    <div className="srv-tab srv-roles">
      <div className="srv-roles-list">
        <button type="button" className="btn-secondary srv-role-create" onClick={handleCreate}>
          <Plus size={14} /> Создать роль
        </button>
        {sortedRoles.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`srv-role-item ${selectedId === r.id ? 'active' : ''}`}
            onClick={() => select(r)}
          >
            {r.is_owner_role ? (
              <Crown size={13} className="srv-role-owner-icon" style={{ color: r.color }} />
            ) : (
              <span className="srv-role-dot" style={{ background: r.color }} />
            )}
            <span className="srv-role-name">{r.name}</span>
            {r.is_owner_role && <span className="srv-role-badge">владелец</span>}
            {r.is_default && <span className="srv-role-badge">для всех</span>}
          </button>
        ))}
      </div>

      <div className="srv-role-editor">
        {!draft ? (
          <div className="modal-empty">Выберите роль слева или создайте новую.</div>
        ) : (
          <>
            <div className="srv-role-editor-head">
              <input
                className="field-input"
                value={draft.name}
                maxLength={100}
                disabled={draft.is_default || draft.is_owner_role}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <input
                type="color"
                value={draft.color}
                disabled={draft.is_owner_role}
                onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                title="Цвет роли"
              />
              {!draft.is_default && !draft.is_owner_role && (
                <button
                  type="button"
                  className="icon-btn danger"
                  title="Удалить роль"
                  onClick={handleDelete}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            {draft.is_default && (
              <p className="srv-hint">
                Роль по умолчанию действует на всех участников сервера — её нельзя
                удалить и не нужно никому выдавать.
              </p>
            )}
            {draft.is_owner_role && (
              <p className="srv-hint">
                Зеркало ваших собственных прав как владельца сервера — по умолчанию
                полных. Можете снять с себя часть (например, «Удаление сообщений»,
                если не хотите модерировать чат лично) — «Управлять сервером» и
                «Управлять ролями» снять нельзя: без них вы бы потеряли доступ к
                этой же вкладке навсегда, а вернуть их было бы уже некому.
              </p>
            )}

            {PERMISSION_GROUPS.map((group) => (
              <div key={group.title} className="srv-perm-group">
                <div className="field-label">{group.title}</div>
                {group.items.map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={draft[key]}
                    label={label}
                    disabled={draft.is_owner_role && OWNER_LOCKED_PERMISSIONS.has(key)}
                    onChange={(v) => handleTogglePermission(key, v)}
                  />
                ))}
              </div>
            ))}

            {!draft.is_default && !draft.is_owner_role && (
              <div className="srv-perm-group">
                <div className="field-label">Кто может упоминать эту роль</div>
                <p className="srv-hint">
                  Сообщение с «@{draft.name}» поднимает уведомление участникам роли, только
                  если у автора есть право её упоминать.
                </p>
                <label className="srv-mention-radio">
                  <input
                    type="radio"
                    name={`mention-perm-${draft.id}`}
                    checked={draft.mention_permission === 'everyone'}
                    onChange={() => setDraft({ ...draft, mention_permission: 'everyone' })}
                  />
                  Все участники сервера
                </label>
                <label className="srv-mention-radio">
                  <input
                    type="radio"
                    name={`mention-perm-${draft.id}`}
                    checked={draft.mention_permission === 'roles'}
                    onChange={() => setDraft({ ...draft, mention_permission: 'roles' })}
                  />
                  Только выбранные роли
                </label>
                {draft.mention_permission === 'roles' && (
                  <div className="srv-mention-roles">
                    {roles
                      .filter((r) => r.id !== draft.id)
                      .map((r) => (
                        <label key={r.id} className="srv-member-row">
                          <input
                            type="checkbox"
                            checked={draft.mentionable_by.includes(r.id)}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                mentionable_by: e.target.checked
                                  ? [...draft.mentionable_by, r.id]
                                  : draft.mentionable_by.filter((id) => id !== r.id),
                              })
                            }
                          />
                          <span className="srv-role-dot" style={{ background: r.color }} />
                          <span className="member-name">{r.name}</span>
                        </label>
                      ))}
                    {roles.length <= 1 && (
                      <p className="srv-hint">На сервере пока нет других ролей.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && <div className="login-error">{error}</div>}
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить роль'}
            </button>

            {!draft.is_default && !draft.is_owner_role && (
              <>
                <div className="field-label">Кому выдана</div>
                <div className="srv-member-picker">
                  {members.map((m) => (
                    <label
                      key={m.id}
                      className={`srv-member-row ${m.is_owner ? 'disabled' : ''}`}
                      title={
                        m.is_owner
                          ? 'Владелец сервера уже обладает всеми правами напрямую — роли на него не влияют, и сервер не даст их назначить.'
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={m.is_owner || m.role_ids.includes(draft.id)}
                        disabled={m.is_owner}
                        onChange={(e) => toggleMemberRole(m, e.target.checked)}
                      />
                      <Avatar
                        name={m.username}
                        color={m.avatar_color}
                        image={m.avatar_image}
                        size={22}
                      />
                      <span className="member-name">{m.username}</span>
                      {m.is_owner && <span className="srv-role-badge">владелец</span>}
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// --- 3. Запросы на вступление ---------------------------------------------

function RequestsTab({
  server,
  onMembersChanged,
}: {
  server: Server
  onMembersChanged: () => void
}) {
  const [requests, setRequests] = useState<ServerJoinRequestEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        setRequests(await api.serverJoinRequests(server.id))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [server.id])

  const decide = async (entry: ServerJoinRequestEntry, approve: boolean) => {
    try {
      if (approve) await api.approveJoinRequest(server.id, entry.id)
      else await api.declineJoinRequest(server.id, entry.id)
      setRequests((prev) => prev.filter((r) => r.id !== entry.id))
      if (approve) onMembersChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) return <div className="modal-empty">Загрузка…</div>

  return (
    <div className="srv-tab">
      {error && <div className="login-error">{error}</div>}
      {requests.length === 0 ? (
        <div className="modal-empty">Заявок нет.</div>
      ) : (
        requests.map((r) => (
          <div key={r.id} className="srv-list-row">
            <Avatar
              name={r.user.username}
              color={r.user.avatar_color}
              image={r.user.avatar_image}
              size={32}
            />
            <div className="srv-list-info">
              <span className="member-name">{r.user.username}</span>
              {r.message && <span className="srv-hint">{r.message}</span>}
            </div>
            <div className="friend-row-actions">
              <button
                type="button"
                className="icon-btn"
                title="Принять"
                onClick={() => decide(r, true)}
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                className="icon-btn danger"
                title="Отклонить"
                onClick={() => decide(r, false)}
              >
                <X size={16} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// --- 4. Доступ ------------------------------------------------------------

function AccessTab({
  server,
  onServerUpdated,
}: {
  server: Server
  onServerUpdated: (s: Server) => void
}) {
  const [accessMode, setAccessMode] = useState<ServerAccessMode>(server.access_mode)
  const [ageRestricted, setAgeRestricted] = useState(server.age_restricted)
  const [rules, setRules] = useState<ServerRule[]>(server.rules)
  const [ruleTitle, setRuleTitle] = useState('')
  const [ruleText, setRuleText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const addRule = () => {
    if (!ruleTitle.trim() && !ruleText.trim()) return
    setRules([...rules, { title: ruleTitle.trim(), text: ruleText.trim() }])
    setRuleTitle('')
    setRuleText('')
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateServer(server.id, {
        access_mode: accessMode,
        age_restricted: ageRestricted,
        rules,
      })
      onServerUpdated(updated)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="srv-tab">
      <div className="field-label">Как попасть на сервер</div>
      {ACCESS_MODES.map((m) => (
        <label key={m.value} className="srv-toggle">
          <input
            type="radio"
            name="access-mode"
            checked={accessMode === m.value}
            onChange={() => {
              setAccessMode(m.value)
              setSaved(false)
            }}
          />
          <span className="srv-toggle-text">
            <span className="srv-toggle-label">{m.label}</span>
            <span className="srv-toggle-hint">{m.hint}</span>
          </span>
        </label>
      ))}

      <div className="field-label">Возрастное ограничение</div>
      <Toggle
        checked={ageRestricted}
        label="Сервер 18+"
        hint="Помечается в поиске серверов."
        onChange={(v) => {
          setAgeRestricted(v)
          setSaved(false)
        }}
      />

      <div className="field-label">Правила сервера</div>
      <p className="srv-hint">Показываются всем новым участникам.</p>
      {rules.length === 0 && <div className="modal-empty">Правил пока нет.</div>}
      {rules.map((rule, i) => (
        <div key={`${rule.title}-${i}`} className="srv-rule">
          <div className="srv-list-info">
            <span className="member-name">
              {i + 1}. {rule.title || 'Без названия'}
            </span>
            {rule.text && <span className="srv-hint">{rule.text}</span>}
          </div>
          <button
            type="button"
            className="icon-btn danger"
            title="Удалить правило"
            onClick={() => {
              setRules(rules.filter((_, idx) => idx !== i))
              setSaved(false)
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="srv-rule-add">
        <input
          className="field-input"
          value={ruleTitle}
          maxLength={120}
          placeholder="Название правила"
          onChange={(e) => setRuleTitle(e.target.value)}
        />
        <textarea
          className="field-input srv-textarea"
          value={ruleText}
          maxLength={2000}
          rows={2}
          placeholder="Пояснение"
          onChange={(e) => setRuleText(e.target.value)}
        />
        <button type="button" className="btn-secondary" onClick={addRule}>
          <Plus size={14} /> Добавить правило
        </button>
      </div>

      {error && <div className="login-error">{error}</div>}
      {saved && !error && <div className="profile-success">Сохранено.</div>}
      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
      </button>
    </div>
  )
}

// --- 5. ЧС списочек xD ----------------------------------------------------

function BansTab({
  server,
  members,
  onMembersChanged,
}: {
  server: Server
  members: Member[]
  onMembersChanged: () => void
}) {
  const [bans, setBans] = useState<ServerBanEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [banTargetId, setBanTargetId] = useState('')
  const [banReason, setBanReason] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        setBans(await api.serverBans(server.id))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [server.id])

  const unban = async (entry: ServerBanEntry) => {
    try {
      await api.unbanMember(server.id, entry.user.id)
      setBans((prev) => prev.filter((b) => b.id !== entry.id))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // Владельца забанить нельзя (бэк тоже откажет) — не предлагаем его вовсе.
  const bannable = members.filter((m) => !m.is_owner)

  const ban = async () => {
    const userId = Number(banTargetId)
    if (!userId) return
    // Подтверждение: бан выкидывает с сервера и закрывает вход обратно, а
    // срабатывал он раньше сразу по клику — при том что удаление одного
    // сообщения (MessageList) подтверждения спрашивает.
    const target = bannable.find((m) => m.id === userId)
    if (!window.confirm(`Забанить ${target?.username ?? 'участника'} на сервере?`)) {
      return
    }
    try {
      const entry = await api.banMember(server.id, userId, banReason.trim())
      setBans((prev) => [entry, ...prev.filter((b) => b.user.id !== userId)])
      setBanTargetId('')
      setBanReason('')
      // Бан заодно выкидывает с сервера — список участников устарел.
      onMembersChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) return <div className="modal-empty">Загрузка…</div>

  return (
    <div className="srv-tab">
      {error && <div className="login-error">{error}</div>}

      <div className="field-label">Забанить участника</div>
      <div className="srv-ban-add">
        <select
          className="field-input"
          value={banTargetId}
          onChange={(e) => setBanTargetId(e.target.value)}
        >
          <option value="">Выберите участника…</option>
          {bannable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.username}
            </option>
          ))}
        </select>
        <input
          className="field-input"
          value={banReason}
          maxLength={300}
          placeholder="Причина (необязательно)"
          onChange={(e) => setBanReason(e.target.value)}
        />
        <button type="button" className="btn-secondary" onClick={ban} disabled={!banTargetId}>
          <ShieldBan size={14} /> Забанить
        </button>
      </div>
      <p className="srv-hint">Бан выкидывает участника с сервера и не даёт вступить снова.</p>

      <div className="field-label">В чёрном списке</div>
      {bans.length === 0 ? (
        <div className="modal-empty">В чёрном списке пусто — и славно.</div>
      ) : (
        bans.map((b) => (
          <div key={b.id} className="srv-list-row">
            <Avatar
              name={b.user.username}
              color={b.user.avatar_color}
              image={b.user.avatar_image}
              size={32}
            />
            <div className="srv-list-info">
              <span className="member-name">{b.user.username}</span>
              <span className="srv-hint">
                {b.reason || 'Без причины'}
                {b.banned_by && ` · забанил ${b.banned_by.username}`}
              </span>
            </div>
            <button type="button" className="btn-small" onClick={() => unban(b)}>
              Разбанить
            </button>
          </div>
        ))
      )}
    </div>
  )
}
