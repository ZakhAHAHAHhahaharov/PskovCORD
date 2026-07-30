import { ReactNode, useEffect, useRef, useState } from 'react'
import {
  LogOut,
  Volume2,
  Mic,
  AudioWaveform,
  X,
  User as UserIcon,
  Image as ImageIcon,
  Palette,
  Monitor,
  Heart,
  ChevronRight,
  ChevronLeft,
  Trash2,
  Loader2,
  QrCode,
  MessageCircle,
  ZoomIn,
  Type,
} from 'lucide-react'
import {
  useSettings,
  DEFAULT_SETTINGS,
  ThemeChoice,
  UI_SCALE_STEPS,
  FONT_SIZE_STEPS,
} from '../settings'
import { useAuth } from '../auth'
import { useEscToClose } from '../modalStack'
import { describeUserAgent, isMobileDevice } from '../deviceInfo'
import { api, Session, DmPrivacy } from '../api'
import QrScannerModal from './QrScannerModal'
import PasswordInput from './PasswordInput'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

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
    subcategories: [
      { id: 'appearance-theme', label: 'Тема оформления' },
      { id: 'appearance-scale', label: 'Масштаб интерфейса' },
      { id: 'appearance-readability', label: 'Удобочитаемость' },
    ],
  },
  {
    id: 'voice',
    label: 'Голос и видео',
    icon: <AudioWaveform size={16} />,
    subcategories: [{ id: 'voice-devices', label: 'Устройства и звук' }],
  },
  {
    id: 'content',
    label: 'Контент и общение',
    icon: <MessageCircle size={16} />,
    subcategories: [{ id: 'content-privacy', label: 'Личные сообщения' }],
  },
]

const DM_PRIVACY_LABELS: Record<DmPrivacy, string> = {
  friends: 'Только друзья',
  nobody: 'Никто',
  everyone: 'Любой зарегистрированный',
}

/** Кто может НАЧАТЬ со мной личку — переехало сюда из ProfileModal, чтобы не
 * дублировать смену пароля/ника рядом с настройками, не завязанными на
 * подтверждение личности. */
function DmPrivacyField() {
  const { user, updateLocalUser } = useAuth()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  const handleChange = async (value: DmPrivacy) => {
    setError('')
    setSaving(true)
    try {
      const updated = await api.updateProfile({ dm_privacy: value })
      updateLocalUser(updated)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">
          <MessageCircle size={15} /> Кто может мне писать личные сообщения
        </span>
      </div>
      <select
        className="field-input"
        value={user.dm_privacy}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value as DmPrivacy)}
      >
        {(Object.keys(DM_PRIVACY_LABELS) as DmPrivacy[]).map((value) => (
          <option key={value} value={value}>
            {DM_PRIVACY_LABELS[value]}
          </option>
        ))}
      </select>
      {error && <div className="login-error">{error}</div>}
    </div>
  )
}

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

/** Ползунок с "магнитными" отметками — в отличие от SliderField (любое
 * значение в диапазоне), тут доступны только конкретные шаги (steps), между
 * ними прыгать нельзя: сам range двигает ИНДЕКС в steps, а не значение
 * напрямую, поэтому и магнитится только к перечисленным отметкам, а не к
 * произвольному проценту между ними. Используется для масштаба интерфейса и
 * размера шрифта (см. UI_SCALE_STEPS/FONT_SIZE_STEPS в settings.tsx). */
function SteppedSliderField({
  icon,
  label,
  steps,
  value,
  unit,
  onChange,
  onReset,
}: {
  icon: ReactNode
  label: string
  steps: number[]
  value: number
  unit: string
  onChange: (v: number) => void
  onReset: () => void
}) {
  // Значение могло прийти из старого localStorage мимо текущего набора
  // отметок — берём ближайшую, а не всегда 0-ю, чтобы ползунок не
  // телепортировался в неожиданное место.
  const closestIndex = steps.reduce(
    (best, s, i) => (Math.abs(s - value) < Math.abs(steps[best] - value) ? i : best),
    0,
  )

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">
          {icon} {label}
        </span>
        <span className="settings-field-value">
          {steps[closestIndex]}
          {unit}
        </span>
      </div>
      <div className="settings-field-row">
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={closestIndex}
          onChange={(e) => onChange(steps[Number(e.target.value)])}
        />
        <button className="settings-field-reset" title="Сбросить по умолчанию" onClick={onReset}>
          <X size={13} />
        </button>
      </div>
      <div className="slider-ticks">
        {steps.map((s, i) => (
          <span key={s} className={`slider-tick${i === closestIndex ? ' active' : ''}`}>
            {s}
            {unit}
          </span>
        ))}
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
 * простых полей учётной записи (ник, пароль, 2FA). Действие открывает
 * отдельное модальное окно (см. UsernameChangeModal/PasswordChangeModal) —
 * не редактируется инлайн. */
function UsernameRow({ onOpen }: { onOpen: () => void }) {
  const { user } = useAuth()
  if (!user) return null
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">Имя пользователя</div>
        <div className="settings-row-value">{user.username}</div>
      </div>
      <button className="settings-row-edit" onClick={onOpen}>
        Изменить
      </button>
    </div>
  )
}

function PasswordRow({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">Пароль</div>
        <div className="settings-row-value">••••••••</div>
      </div>
      <button className="settings-row-edit" onClick={onOpen}>
        Изменить
      </button>
    </div>
  )
}

/** Смена ника — требует текущий пароль (см. backend
 * ProfileUpdateSerializer.validate): ник виден всем и первое, что видит
 * владелец при угоне сессии, — проверка пароля ловит момент, когда кто-то с
 * чужим access-токеном пытается тихо переименовать аккаунт себе. */
function UsernameChangeModal({ onClose, isMobile }: { onClose: () => void; isMobile?: boolean }) {
  useEscToClose(onClose)
  const { user, updateLocalUser } = useAuth()
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState(user?.username ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  const trimmed = username.trim()
  const canSubmit = password.length > 0 && trimmed.length > 0 && trimmed !== user.username

  const save = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateProfile({ username: trimmed, current_password: password })
      updateLocalUser(updated)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay settings-sub-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {isMobile && (
            <button className="chat-back-btn" title="Назад" onClick={onClose}>
              <ChevronLeft size={20} />
            </button>
          )}
          Изменить имя пользователя
        </h2>

        <div className="field-label">Текущий пароль</div>
        <PasswordInput
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />

        <div className="field-label">Новое имя пользователя</div>
        <input
          className="field-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={150}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={save} disabled={saving || !canSubmit}>
          {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
        </button>
        {/* На мобилке эта кнопка дублирует стрелку назад в заголовке. */}
        {!isMobile && (
          <button className="modal-close" onClick={onClose}>
            Отмена
          </button>
        )}
      </div>
    </div>
  )
}

function PasswordChangeModal({ onClose, isMobile }: { onClose: () => void; isMobile?: boolean }) {
  useEscToClose(onClose)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [next2, setNext2] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay settings-sub-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {isMobile && (
            <button className="chat-back-btn" title="Назад" onClick={onClose}>
              <ChevronLeft size={20} />
            </button>
          )}
          Смена пароля
        </h2>

        <div className="field-label">Текущий пароль</div>
        <PasswordInput
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoFocus
        />
        <div className="field-label">Новый пароль</div>
        <PasswordInput
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <div className="field-label">Повторите новый пароль</div>
        <PasswordInput
          autoComplete="new-password"
          value={next2}
          onChange={(e) => setNext2(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={save} disabled={saving || !current || !next}>
          {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
        </button>
        {!isMobile && (
          <button className="modal-close" onClick={onClose}>
            Отмена
          </button>
        )}
      </div>
    </div>
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

function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SessionRow({
  session,
  onRevoke,
  revoking,
}: {
  session: Session
  /** Есть только у "других устройств" — свой текущий сеанс так не отзывают,
   * для него обычный выход (см. backend SessionDetailView.delete — 400). */
  onRevoke?: () => void
  revoking?: boolean
}) {
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
      {onRevoke && (
        <button
          className="session-row-revoke"
          title="Завершить сеанс"
          onClick={onRevoke}
          disabled={revoking}
        >
          {revoking ? <Loader2 size={13} className="spin" /> : <X size={15} />}
        </button>
      )}
    </div>
  )
}

/** Строка-триггер "Активные сеансы — Посмотреть >" — открывает detail-view
 * (см. SettingsModal.detailView), а не аккордеон на месте. */
function SessionsSummaryRow({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="settings-row settings-row-clickable" onClick={onOpen}>
      <div className="settings-row-info">
        <div className="settings-row-label">Активные сеансы</div>
      </div>
      <span className="settings-row-summary">
        Посмотреть
        <ChevronRight size={15} className="settings-chevron" />
      </span>
    </button>
  )
}

/** Detail-view "Активные сеансы" — подменяет собой весь settings-content
 * (см. SettingsModal), пока подкатегория в сайдбаре по-прежнему подсвечивает
 * "Пароль и безопасность", которой этот экран принадлежит. */
function SessionsDetailView({ onBack }: { onBack: () => void }) {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revokingId, setRevokingId] = useState<number | null>(null)
  const [revokingAll, setRevokingAll] = useState(false)

  const load = async () => {
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

  useEffect(() => {
    void load()
  }, [])

  const revoke = async (id: number) => {
    setRevokingId(id)
    try {
      await api.revokeSession(id)
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null)
    } catch (err) {
      window.alert((err as Error).message)
    } finally {
      setRevokingId(null)
    }
  }

  const revokeAll = async () => {
    if (
      !window.confirm(
        'Выйти на всех известных устройствах? Придётся войти заново на каждом из них, включая это.',
      )
    ) {
      return
    }
    setRevokingAll(true)
    try {
      await api.revokeAllSessions()
      await load()
    } catch (err) {
      window.alert((err as Error).message)
    } finally {
      setRevokingAll(false)
    }
  }

  const current = sessions?.find((s) => s.is_current) ?? null
  const others = sessions?.filter((s) => !s.is_current) ?? []

  return (
    <div className="settings-detail">
      <button className="settings-detail-back" onClick={onBack}>
        <ChevronLeft size={16} /> Пароль и безопасность
      </button>
      <h3 className="settings-section-title">Активные сеансы</h3>
      <p className="settings-hint">
        Все устройства, на которых осуществлён вход в учётную запись {APP_NAME}. Выйдите из
        учётной записи на устройствах, которые вы не узнаёте.
      </p>

      {loading && <div className="settings-hint">Загрузка…</div>}
      {error && <div className="login-error">{error}</div>}
      {/* Едва ли не единственный случай — если этот же сеанс только что сам
          отозвал все сеансы (смена пароля/«выйти на всех устройствах») и
          список ещё не наполнился заново. */}
      {!loading && !error && sessions?.length === 0 && (
        <div className="settings-hint">Нет активных сеансов.</div>
      )}

      {current && (
        <>
          <h4 className="settings-detail-subhead">Текущее устройство</h4>
          <div className="sessions-list">
            <SessionRow session={current} />
          </div>
        </>
      )}

      {others.length > 0 && (
        <>
          <h4 className="settings-detail-subhead">Другие устройства</h4>
          <div className="sessions-list">
            {others.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onRevoke={() => revoke(s.id)}
                revoking={revokingId === s.id}
              />
            ))}
          </div>
        </>
      )}

      <div className="settings-danger-zone">
        <div className="settings-row-label">Выйти на всех известных устройствах</div>
        <p className="settings-hint">
          Вам придётся повторно войти в учётную запись на всех устройствах, где вы выполнили
          вход.
        </p>
        <button className="settings-danger-btn" onClick={revokeAll} disabled={revokingAll}>
          {revokingAll ? <Loader2 size={15} className="spin" /> : <LogOut size={15} />} Выйти на
          всех известных устройствах
        </button>
      </div>
    </div>
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
  isMobile,
}: {
  onClose: () => void
  onLogout: () => void
  /** На мобилке настройки — полноэкранный "слой" со стрелкой назад в
   * шапке вместо центрированной модалки (см. .settings-overlay в index.css
   * и AppShell.openMobileSettings/closeSettings). */
  isMobile?: boolean
}) {
  const {
    outputVolume,
    setOutputVolume,
    micGain,
    setMicGain,
    micThreshold,
    setMicThreshold,
    uiScale,
    setUiScale,
    baseFontSize,
    setBaseFontSize,
  } = useSettings()

  useEscToClose(onClose)

  // На мобилке список категорий и контент категории — два разных полных
  // экрана (тап по категории "открывает" контент, кнопка назад
  // возвращает к списку), а не совмещённый вид, как на ПК. На ПК это
  // состояние не используется вовсе (сайдбар и контент всегда видны
  // разом), поэтому обычным переключением категорий (см.
  // handleCategoryClick) не трогается, если !isMobile.
  const [mobileCategoryOpen, setMobileCategoryOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id)
  const [activeSubcategory, setActiveSubcategory] = useState(CATEGORIES[0].subcategories[0].id)
  // "Посмотреть >" (например, Активные сеансы) подменяет собой весь
  // settings-content вместо аккордеона на месте — сайдбар при этом не
  // трогаем, подкатегория-владелец (см. каждый detailView) остаётся
  // подсвеченной, как и была.
  const [detailView, setDetailView] = useState<null | 'sessions'>(null)
  const [activeModal, setActiveModal] = useState<null | 'username' | 'password' | 'qrScanner'>(
    null,
  )
  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Кнопка «Сканировать QR» имеет смысл только на телефоне/планшете с
  // камерой — enumerateDevices() до выдачи разрешения всё равно возвращает
  // kind у устройств, так что определить наличие камеры можно без запроса
  // доступа заранее.
  const [canScanQr, setCanScanQr] = useState(false)
  useEffect(() => {
    if (!isMobileDevice() || !navigator.mediaDevices?.enumerateDevices) return
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => setCanScanQr(devices.some((d) => d.kind === 'videoinput')))
      .catch(() => {})
  }, [])

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
    setDetailView(null)
    if (isMobile) setMobileCategoryOpen(true)
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
    setDetailView(null)
    // Не полагаемся только на IntersectionObserver — если все секции
    // категории умещаются на экране без скролла (например, "Учётная
    // запись" после переезда смены ника/пароля в модалки стала короче),
    // scrollIntoView() физически ничего не сдвинет и observer никогда не
    // сработает, а клик по подкатегории обязан подсветить её сразу.
    setActiveSubcategory(id)
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {isMobile && (
            // Открыта категория — стрелка закрывает ТОЛЬКО её (возврат к
            // списку категорий), а не весь экран настроек; сам заголовок
            // тогда тоже подменяется на название категории — единственный
            // хедер вместо "Настройки" сверху + отдельного мини-хедера
            // категории под ним, как было раньше (см. удалённый
            // .settings-content-back ниже).
            <button
              className="chat-back-btn"
              title="Назад"
              onClick={() => {
                if (mobileCategoryOpen) {
                  setMobileCategoryOpen(false)
                  setDetailView(null)
                } else {
                  onClose()
                }
              }}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          {isMobile && mobileCategoryOpen ? currentCategory.label : 'Настройки'}
        </h2>

        <div className={`settings-body${mobileCategoryOpen ? ' mobile-category-open' : ''}`}>
          <nav className="settings-sidebar">
            {CATEGORIES.map((c) => (
              <div key={c.id} className="settings-category-group">
                <button
                  className={`settings-sidebar-item${activeCategory === c.id ? ' active' : ''}`}
                  onClick={() => handleCategoryClick(c)}
                >
                  {c.icon} {c.label}
                  {isMobile && <ChevronRight size={15} className="settings-row-chevron" />}
                </button>
                {!isMobile && activeCategory === c.id && (
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
              {canScanQr && (
                <button
                  className="settings-sidebar-item"
                  onClick={() => setActiveModal('qrScanner')}
                >
                  <QrCode size={16} /> Сканировать QR
                </button>
              )}
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
            {detailView === 'sessions' ? (
              <SessionsDetailView onBack={() => setDetailView(null)} />
            ) : activeCategory === 'account' ? (
              <>
                <SettingsSection
                  id="account-info"
                  title="Информация об учётной записи"
                  sectionRefs={sectionRefs}
                >
                  <UsernameRow onOpen={() => setActiveModal('username')} />
                </SettingsSection>

                <SettingsSection
                  id="account-security"
                  title="Пароль и безопасность"
                  sectionRefs={sectionRefs}
                >
                  <PasswordRow onOpen={() => setActiveModal('password')} />
                  <TwoFactorRow />
                  <SessionsSummaryRow
                    onOpen={() => {
                      // На случай если сессии открыли, пока в сайдбаре ещё
                      // подсвечена "Информация об учётной записи" — этот
                      // detail-view принадлежит именно "Пароль и безопасность".
                      setActiveSubcategory('account-security')
                      setDetailView('sessions')
                    }}
                  />
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
            ) : null}

            {!detailView && activeCategory === 'appearance' && (
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

            {!detailView && activeCategory === 'appearance' && (
              <SettingsSection
                id="appearance-scale"
                title="Масштаб интерфейса"
                sectionRefs={sectionRefs}
              >
                <SteppedSliderField
                  icon={<ZoomIn size={15} />}
                  label="Масштаб интерфейса"
                  steps={UI_SCALE_STEPS}
                  value={uiScale}
                  unit="%"
                  onChange={setUiScale}
                  onReset={() => setUiScale(DEFAULT_SETTINGS.uiScale)}
                />
                <p className="settings-hint">
                  Меняет размер вообще всего: иконок, отступов и текста разом — как зум
                  страницы в браузере.
                </p>
              </SettingsSection>
            )}

            {!detailView && activeCategory === 'appearance' && (
              <SettingsSection
                id="appearance-readability"
                title="Удобочитаемость"
                sectionRefs={sectionRefs}
              >
                <SteppedSliderField
                  icon={<Type size={15} />}
                  label="Размер шрифта"
                  steps={FONT_SIZE_STEPS}
                  value={baseFontSize}
                  unit="px"
                  onChange={setBaseFontSize}
                  onReset={() => setBaseFontSize(DEFAULT_SETTINGS.baseFontSize)}
                />
                <p className="settings-hint">
                  Меняет только размер текста — иконки и отступы остаются как есть. На
                  телефоне поля ввода всё равно не мельче 16px: иначе браузер сам
                  приближает страницу при тапе в поле.
                </p>
              </SettingsSection>
            )}

            {!detailView && activeCategory === 'voice' && (
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

            {!detailView && activeCategory === 'content' && (
              <SettingsSection
                id="content-privacy"
                title="Личные сообщения"
                sectionRefs={sectionRefs}
              >
                <DmPrivacyField />
              </SettingsSection>
            )}
          </div>
        </div>

        {/* На мобилке закрытие — стрелка назад в шапке (см. modal-title
            выше), эта кнопка там просто дублирует её и занимает место
            снизу полноэкранного слоя. */}
        {!isMobile && (
          <button className="modal-close" onClick={onClose}>
            Закрыть
          </button>
        )}
      </div>
    </div>

    {/* Не вложены в .modal-overlay настроек выше — иначе клик мимо этой
        под-модалки (но всё ещё внутри overlay настроек) всплыл бы до его
        onClick и закрыл заодно и Настройки целиком. */}
    {activeModal === 'username' && (
      <UsernameChangeModal onClose={() => setActiveModal(null)} isMobile={isMobile} />
    )}
    {activeModal === 'password' && (
      <PasswordChangeModal onClose={() => setActiveModal(null)} isMobile={isMobile} />
    )}
    {activeModal === 'qrScanner' && (
      <QrScannerModal onClose={() => setActiveModal(null)} isMobile={isMobile} />
    )}
    </>
  )
}
