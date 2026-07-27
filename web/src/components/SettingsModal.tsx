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
} from 'lucide-react'
import { useSettings, DEFAULT_SETTINGS, ThemeChoice } from '../settings'

// RMS, соответствующий 100% ширины шкалы чувствительности — обычная громкая
// речь в микрофон редко превышает это значение. Порог живёт в её левой
// половине (см. THRESHOLD_MIN/MAX) — заведомо громче этого настраивать
// бессмысленно.
const METER_SCALE = 0.3
const THRESHOLD_MIN = 0.005
const THRESHOLD_MAX = 0.15
const THRESHOLD_STEP = 0.005

type SettingsCategory = 'account' | 'appearance' | 'voice'

const CATEGORIES: { id: SettingsCategory; label: string; icon: ReactNode }[] = [
  { id: 'account', label: 'Аккаунт', icon: <UserIcon size={16} /> },
  { id: 'appearance', label: 'Внешний вид', icon: <Palette size={16} /> },
  { id: 'voice', label: 'Голос и видео', icon: <AudioWaveform size={16} /> },
]

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
  const [category, setCategory] = useState<SettingsCategory>('account')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Настройки</h2>

        <div className="settings-body">
          <nav className="settings-sidebar">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                className={`settings-sidebar-item${category === c.id ? ' active' : ''}`}
                onClick={() => setCategory(c.id)}
              >
                {c.icon} {c.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {category === 'account' && (
              <button className="settings-logout" onClick={onLogout}>
                <LogOut size={15} /> Выйти из аккаунта
              </button>
            )}

            {category === 'appearance' && (
              <>
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
              </>
            )}

            {category === 'voice' && (
              <>
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
              </>
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
