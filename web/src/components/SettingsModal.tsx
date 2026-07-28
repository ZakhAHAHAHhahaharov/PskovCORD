import { ReactNode, useEffect, useRef, useState } from 'react'
import {
  LogOut,
  Volume2,
  Mic,
  AudioWaveform,
  X,
  Check,
  User as UserIcon,
  Image as ImageIcon,
  Palette,
  Monitor,
  Heart,
  ChevronRight,
  Trash2,
  Loader2,
} from 'lucide-react'
import { useSettings, DEFAULT_SETTINGS, ThemeChoice } from '../settings'
import { useAuth } from '../auth'
import { api, Session } from '../api'

// RMS, соответствующий 100% ширины шкалы чувствительности — обычная громкая
// речь в микрофон редко превышает это значение. Порог живёт в её левой
// половине (см. THRESHOLD_MIN/MAX) — заведомо громче этого настраивать
// бессмысленно.
const METER_SCALE = 0.3
const THRESHOLD_MIN = 0.005
const THRESHOLD_MAX = 0.15
const THRESHOLD_STEP = 0.005

interface Subcategory {
  id: string
  label: string
}

interface Category {
  id: string
  label: string
  icon: ReactNode
  subcategories: Subcategory[]
}

const CATEGORIES: Category[] = [
  {
    id: 'account',
    label: 'Учётная запись',
    icon: <UserIcon size={16} />,
    subcategories: [
      { id: 'account-info', label: 'Информация об учётной записи' },
      { id: 'account-security', label: 'Пароль и безопасность' },
    ],
  },
  {
    id: 'appearance',
    label: 'Внешний вид',
    icon: <Palette size={16} />,
    subcategories: [{ id: 'appearance-theme', label: 'Тема оформления' }],
  },
  {
    id: 'voice',
    label: 'Голос и видео',
    icon: <AudioWaveform size={16} />,
    subcategories: [{ id: 'voice-devices', label: 'Устройства и звук' }],
  },
]

/** Живой уровень СВОЕГО микрофона — отдельный от голосового канала захват:
 * раньше метр показывал что-то только во время звонка (getMicLevel() из
 * useVoice брал уровень с потока активного звонка), теперь чувствительность
 * можно подобрать заранее, без захода в канал. Обновляется через
 * requestAnimationFrame напрямую в DOM, минуя React state, чтобы 60 кадров/с
 * не гоняли ре-рендер всего модала. */
function useMicLevelMeter(fillRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let audioCtx: AudioContext | null = null
    let rafId = 0

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext
        if (!AudioCtx) return
        audioCtx = new AudioCtx()
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        const data = new Uint8Array(analyser.fftSize)

        const tick = () => {
          analyser.getByteTimeDomainData(data)
          let sumSquares = 0
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128
            sumSquares += v * v
          }
          const rms = Math.sqrt(sumSquares / data.length)
          const pct = Math.min(100, (rms / METER_SCALE) * 100)
          if (fillRef.current) fillRef.current.style.width = `${pct}%`
          rafId = requestAnimationFrame(tick)
        }
        rafId = requestAnimationFrame(tick)
      } catch {
        // Микрофон недоступен/запрещён — полоса просто остаётся пустой.
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      stream?.getTracks().forEach((t) => t.stop())
      audioCtx?.close().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** Чувствительность микрофона — один элемент вместо ползунка и отдельного
 * метра под ним: живой уровень и порог срабатывания рисуются на общей шкале
 * (0..METER_SCALE), а сама метка порога — это же самое место, где стоит
 * невидимый native <input type="range">, растянутый ровно на диапазон
 * THRESHOLD_MIN..MAX той же шкалы. Поэтому перетаскивание метки и клик по
 * полосе двигают один и тот же порог, без рассинхрона между "слайдером" и
 * "метром", которые раньше были разными элементами с разными масштабами. */
function MicSensitivityField({
  value,
  onChange,
  onReset,
}: {
  value: number
  onChange: (v: number) => void
  onReset: () => void
}) {
  const fillRef = useRef<HTMLDivElement>(null)
  useMicLevelMeter(fillRef)

  const displayValue =
    value <= 0.01 ? 'Максимальная' : value >= 0.14 ? 'Минимальная' : 'Средняя'
  const thumbPct = (value / METER_SCALE) * 100
  const inputLeftPct = (THRESHOLD_MIN / METER_SCALE) * 100
  const inputWidthPct = ((THRESHOLD_MAX - THRESHOLD_MIN) / METER_SCALE) * 100

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">
          <AudioWaveform size={15} /> Чувствительность микрофона
        </span>
        <span className="settings-field-value">{displayValue}</span>
      </div>
      <div className="settings-field-row">
        <div className="mic-sensitivity">
          <div className="mic-sensitivity-fill" ref={fillRef} />
          <div className="mic-sensitivity-thumb" style={{ left: `${thumbPct}%` }} />
          <input
            type="range"
            className="mic-sensitivity-input"
            style={{ left: `${inputLeftPct}%`, width: `${inputWidthPct}%` }}
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={THRESHOLD_STEP}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
        <button className="settings-field-reset" title="Сбросить по умолчанию" onClick={onReset}>
          <X size={13} />
        </button>
      </div>
      <p className="settings-hint">
        Зелёная полоса — живой уровень вашего микрофона, работает и вне голосового канала.
        Кружок — порог: перетащите его туда, с какой громкости у вас должно загораться
        кольцо «говорит».
      </p>
    </div>
  )
}

function SliderField({
  icon,
  label,
  value,
  displayValue,
  min,
  max,
  step,
  onChange,
  onReset,
}: {
  icon: ReactNode
  label: string
  value: number
  displayValue: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onReset: () => void
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">
          {icon} {label}
        </span>
        <span className="settings-field-value">{displayValue}</span>
      </div>
      <div className="settings-field-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button className="settings-field-reset" title="Сбросить по умолчанию" onClick={onReset}>
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

// Превью — реальные цвета rail/chat той темы, чтобы кружок в выборе совпадал
// с тем, что реально увидишь после переключения (см. [data-theme=...] в
// index.css). 'system' — свой вид (иконка монитора), это не палитра сама
// по себе, а разрешение в dark/light по ОС.
const THEME_OPTIONS: { id: ThemeChoice; label: string; swatch: [string, string] | null }[] = [
  { id: 'dark', label: 'Тёмная', swatch: ['#2b2d31', '#313338'] },
  { id: 'light', label: 'Светлая', swatch: ['#f2f3f5', '#ffffff'] },
  { id: 'oled', label: 'Оникс', swatch: ['#0a0a0a', '#000000'] },
  { id: 'ash', label: 'Пепел', swatch: ['#4b4d54', '#54565d'] },
  { id: 'system', label: 'Системная', swatch: null },
]

function ThemePicker() {
  const { theme, setTheme } = useSettings()

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">
          <Palette size={15} /> Тема оформления
        </span>
      </div>
      <div className="theme-picker">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            className={`theme-option${theme === opt.id ? ' active' : ''}`}
            onClick={() => setTheme(opt.id)}
          >
            {opt.swatch ? (
              <span
                className="theme-swatch"
                style={{
                  background: `linear-gradient(135deg, ${opt.swatch[0]} 50%, ${opt.swatch[1]} 50%)`,
                }}
              />
            ) : (
              <span className="theme-swatch system">
                <Monitor size={16} />
              </span>
            )}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Строка "лейбл + текущее значение + квадратная кнопка" — общий вид для
 * простых полей учётной записи (ник, пароль, 2FA). */
function UsernameRow() {
  const { user, updateLocalUser } = useAuth()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(user?.username ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  const startEdit = () => {
    setValue(user.username)
    setError('')
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setError('')
  }
  const save = async () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('Ник не может быть пустым.')
      return
    }
    if (trimmed === user.username) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError('')
    try {
      // Смена ника — обычный PATCH /api/auth/me, никак не трогает
      // access/refresh — в отличие от смены пароля, здесь НЕ должно
      // разлогинивать.
      const updated = await api.updateProfile({ username: trimmed })
      updateLocalUser(updated)
      setEditing(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Имя пользователя</div>
          {editing ? (
            <input
              className="settings-row-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={150}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          ) : (
            <div className="settings-row-value">{user.username}</div>
          )}
        </div>
        {editing ? (
          <div className="settings-row-actions">
            <button className="settings-row-icon-btn" title="Отмена" onClick={cancel} disabled={saving}>
              <X size={15} />
            </button>
            <button
              className="settings-row-icon-btn primary"
              title="Сохранить"
              onClick={save}
              disabled={saving}
            >
              {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            </button>
          </div>
        ) : (
          <button className="settings-row-edit" onClick={startEdit}>
            Изменить
          </button>
        )}
      </div>
      {error && <div className="login-error settings-row-error">{error}</div>}
    </>
  )
}

function PasswordRow() {
  const [editing, setEditing] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [next2, setNext2] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const toggle = () => {
    setEditing((v) => !v)
    setCurrent('')
    setNext('')
    setNext2('')
    setError('')
    setDone(false)
  }

  const save = async () => {
    setError('')
    if (next.length < 4) {
      setError('Новый пароль должен быть не короче 4 символов.')
      return
    }
    if (next !== next2) {
      setError('Пароли не совпадают.')
      return
    }
    setSaving(true)
    try {
      await api.changePassword(current, next)
      setEditing(false)
      setCurrent('')
      setNext('')
      setNext2('')
      setDone(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Пароль</div>
          <div className="settings-row-value">••••••••</div>
        </div>
        <button className="settings-row-edit" onClick={toggle}>
          {editing ? 'Отмена' : 'Изменить'}
        </button>
      </div>
      {editing && (
        <div className="settings-row-form">
          <input
            className="field-input"
            type="password"
            placeholder="Текущий пароль"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
          />
          <input
            className="field-input"
            type="password"
            placeholder="Новый пароль"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            className="field-input"
            type="password"
            placeholder="Повторите новый пароль"
            autoComplete="new-password"
            value={next2}
            onChange={(e) => setNext2(e.target.value)}
          />
          {error && <div className="login-error">{error}</div>}
          <button
            className="btn-primary settings-row-form-submit"
            onClick={save}
            disabled={saving || !current || !next}
          >
            {saving ? <Loader2 size={15} className="spin" /> : 'Сменить пароль'}
          </button>
        </div>
      )}
      {done && !editing && <div className="profile-success">Пароль изменён.</div>}
    </>
  )
}

function TwoFactorRow() {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">Двухфакторная аутентификация</div>
        <div className="settings-row-value">Выключена</div>
      </div>
      <button
        className="settings-row-edit"
        onClick={() =>
          window.alert(
            'Двухфакторная аутентификация скоро появится здесь — пока не реализована.',
          )
        }
      >
        Включить
      </button>
    </div>
  )
}

/** Грубый парсинг User-Agent для читаемой строки в списке сеансов — без
 * зависимостей, ровно те платформы/браузеры, что реально встретятся. */
function describeUserAgent(ua: string): string {
  if (!ua) return 'Неизвестное устройство'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'неизвестная ОС'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'браузер'
  return `${browser} · ${os}`
}

function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SessionRow({ session }: { session: Session }) {
  return (
    <div className="session-row">
      <Monitor size={18} className="session-row-icon" />
      <div className="session-row-info">
        <div className="session-row-device">
          {describeUserAgent(session.user_agent)}
          {session.is_current && <span className="session-row-current">Это устройство</span>}
        </div>
        <div className="session-row-meta">
          {session.ip_address ?? 'IP неизвестен'} · последняя активность{' '}
          {formatSessionDate(session.last_seen_at)}
        </div>
      </div>
    </div>
  )
}

function SessionsRow() {
  const [expanded, setExpanded] = useState(false)
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const toggle = async () => {
    const next = !expanded
    setExpanded(next)
    if (next && sessions === null) {
      setLoading(true)
      setError('')
      try {
        setSessions(await api.getSessions())
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <>
      <button className="settings-row settings-row-clickable" onClick={toggle}>
        <div className="settings-row-info">
          <div className="settings-row-label">Активные сеансы</div>
        </div>
        <span className="settings-row-summary">
          {sessions ? `${sessions.length} устройств` : 'Посмотреть'}
          <ChevronRight size={15} className={expanded ? 'settings-chevron open' : 'settings-chevron'} />
        </span>
      </button>
      {expanded && (
        <div className="sessions-list">
          {loading && <div className="settings-hint">Загрузка…</div>}
          {error && <div className="login-error">{error}</div>}
          {sessions?.length === 0 && <div className="settings-hint">Нет активных сеансов.</div>}
          {sessions?.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </div>
      )}
    </>
  )
}

/** Обёртка секции подкатегории внутри контента: сам div — якорь для
 * скролла/scrollspy (см. SettingsModal — IntersectionObserver следит именно
 * за этими обёртками, а клик по подкатегории в сайдбаре скроллит к ним же). */
function SettingsSection({
  id,
  title,
  sectionRefs,
  children,
}: {
  id: string
  title: string
  sectionRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  children: ReactNode
}) {
  return (
    <div className="settings-section" data-subcat={id} ref={(el) => (sectionRefs.current[id] = el)}>
      <h3 className="settings-section-title">{title}</h3>
      {children}
    </div>
  )
}

export default function SettingsModal({
  onClose,
  onLogout,
}: {
  onClose: () => void
  onLogout: () => void
}) {
  const {
    outputVolume,
    setOutputVolume,
    micGain,
    setMicGain,
    micThreshold,
    setMicThreshold,
  } = useSettings()

  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id)
  const [activeSubcategory, setActiveSubcategory] = useState(CATEGORIES[0].subcategories[0].id)
  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const currentCategory = CATEGORIES.find((c) => c.id === activeCategory)!

  // Категории переключаются только кликом (см. handleCategoryClick), а вот
  // подсветка АКТИВНОЙ подкатегории внутри уже открытой — по скроллу
  // содержимого (как якоря страницы): IntersectionObserver с
  // rootMargin, схлопывающим область наблюдения к верхним ~30% контента,
  // считает "активной" ту секцию, чей заголовок сейчас там оказался.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length === 0) return
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
        )
        const id = (top.target as HTMLElement).dataset.subcat
        if (id) setActiveSubcategory(id)
      },
      { root, threshold: 0, rootMargin: '0px 0px -70% 0px' },
    )
    currentCategory.subcategories.forEach((s) => {
      const el = sectionRefs.current[s.id]
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [currentCategory])

  const handleCategoryClick = (category: Category) => {
    if (category.id === activeCategory) return
    setActiveCategory(category.id)
    setActiveSubcategory(category.subcategories[0].id)
    // Новая категория — как переход на другую страницу, скролл сбрасываем
    // мгновенно, а не в старую позицию прошлой категории.
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = 0
    })
  }

  const scrollToSubcategory = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Настройки</h2>

        <div className="settings-body">
          <nav className="settings-sidebar">
            {CATEGORIES.map((c) => (
              <div key={c.id} className="settings-category-group">
                <button
                  className={`settings-sidebar-item${activeCategory === c.id ? ' active' : ''}`}
                  onClick={() => handleCategoryClick(c)}
                >
                  {c.icon} {c.label}
                </button>
                {activeCategory === c.id && (
                  <div className="settings-subcategory-list">
                    {c.subcategories.map((s) => (
                      <button
                        key={s.id}
                        className={`settings-subcategory-item${
                          activeSubcategory === s.id ? ' active' : ''
                        }`}
                        onClick={() => scrollToSubcategory(s.id)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            <div className="settings-sidebar-pinned">
              <button
                className="settings-sidebar-item"
                onClick={() =>
                  window.alert('Пожертвования разработчикам скоро появятся здесь.')
                }
              >
                <Heart size={16} /> Пожертвовать
              </button>
              <button
                className="settings-sidebar-item danger"
                onClick={() => {
                  if (window.confirm('Точно выйти из аккаунта?')) onLogout()
                }}
              >
                <LogOut size={16} /> Выйти
              </button>
            </div>
          </nav>

          <div className="settings-content" ref={contentRef}>
            {activeCategory === 'account' && (
              <>
                <SettingsSection
                  id="account-info"
                  title="Информация об учётной записи"
                  sectionRefs={sectionRefs}
                >
                  <UsernameRow />
                </SettingsSection>

                <SettingsSection
                  id="account-security"
                  title="Пароль и безопасность"
                  sectionRefs={sectionRefs}
                >
                  <PasswordRow />
                  <TwoFactorRow />
                  <SessionsRow />
                  <div className="settings-danger-zone">
                    <button
                      className="settings-danger-btn"
                      onClick={() =>
                        window.alert(
                          'Удаление аккаунта скоро появится здесь — сначала нужны ' +
                            'дополнительные подтверждения намерения, чтобы аккаунт нельзя ' +
                            'было удалить случайно.',
                        )
                      }
                    >
                      <Trash2 size={15} /> Удалить аккаунт
                    </button>
                  </div>
                </SettingsSection>
              </>
            )}

            {activeCategory === 'appearance' && (
              <SettingsSection
                id="appearance-theme"
                title="Тема оформления"
                sectionRefs={sectionRefs}
              >
                <ThemePicker />

                <button
                  className="settings-logout"
                  onClick={() =>
                    window.alert(
                      'Выбор своей иконки вкладки скоро появится здесь. Пока стандартную иконку задаёт администратор через панель Django.',
                    )
                  }
                >
                  <ImageIcon size={15} /> Иконка сайта (скоро)
                </button>
              </SettingsSection>
            )}

            {activeCategory === 'voice' && (
              <SettingsSection
                id="voice-devices"
                title="Устройства и звук"
                sectionRefs={sectionRefs}
              >
                <SliderField
                  icon={<Volume2 size={15} />}
                  label="Громкость собеседников"
                  value={outputVolume}
                  displayValue={`${Math.round(outputVolume * 100)}%`}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setOutputVolume}
                  onReset={() => setOutputVolume(DEFAULT_SETTINGS.outputVolume)}
                />

                <SliderField
                  icon={<Mic size={15} />}
                  label="Громкость своего микрофона"
                  value={micGain}
                  displayValue={`${Math.round(micGain * 100)}%`}
                  min={0}
                  max={2}
                  step={0.01}
                  onChange={setMicGain}
                  onReset={() => setMicGain(DEFAULT_SETTINGS.micGain)}
                />

                <MicSensitivityField
                  value={micThreshold}
                  onChange={setMicThreshold}
                  onReset={() => setMicThreshold(DEFAULT_SETTINGS.micThreshold)}
                />
              </SettingsSection>
            )}
          </div>
        </div>

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
