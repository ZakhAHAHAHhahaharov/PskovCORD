import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

/** 'system' следует за prefers-color-scheme ОС; сами палитры — см.
 * [data-theme=...] блоки в index.css. */
export type ThemeChoice = 'dark' | 'light' | 'oled' | 'ash' | 'system'

/** Локальные настройки устройства — не синхронизируются с сервером, живут в localStorage. */
export interface Settings {
  /** Громкость входящего звука (голос собеседников + звук демонстрации), 0..1. */
  outputVolume: number
  /** Усиление своего микрофона перед отправкой, 0..2 (1 — без изменений). */
  micGain: number
  /** Порог RMS, с которого микрофон считается "говорящим" (индикатор + кольцо). */
  micThreshold: number
  theme: ThemeChoice
  /** Мьют/дефен — применяются как стартовое состояние при следующем входе в
   * голосовой канал (см. useVoiceMesh в voice.ts), а сами кнопки в
   * user-panel (SidebarBottomBar) переключают их и вне звонка. Синхронизируются
   * и в обратную сторону — переключение мьюта/дефена ВНУТРИ звонка (MicButton/
   * DeafenButton → voice.ts toggleMute/toggleDeafen) обновляет их же, чтобы
   * следующий вход продолжил с того же состояния. */
  preferMicMuted: boolean
  preferDeafened: boolean
  /** Масштаб всего интерфейса, % (100 — как есть). Тянет за собой иконки,
   * отступы и текст разом через CSS zoom на <html> (см. applyUiScale) —
   * в отличие от baseFontSize ниже, который трогает только текст. Отметки,
   * к которым магнитится ползунок, — UI_SCALE_STEPS. */
  uiScale: number
  /** Базовый размер шрифта, px — множитель ко ВСЕМ font-size в index.css
   * (см. calc(...px * var(--font-scale)) там же и applyFontScale ниже), но
   * не трогает иконки/отступы, в отличие от uiScale. FONT_SIZE_BASELINE —
   * то значение, при котором множитель равен 1 (текст выглядит как сейчас). */
  baseFontSize: number
  /** Показывать системные уведомления, когда вкладка не на виду (см.
   * web/src/notifications.ts). Отдельно от разрешения браузера: разрешение
   * даётся один раз и навсегда, а выключить уведомления, не отзывая его
   * через настройки сайта, человек должен уметь здесь. */
  desktopNotifications: boolean
  /** Проигрывать короткий звук вместе с уведомлением. */
  notificationSound: boolean
  /** Качество демонстрации экрана — выбирается в модалке при её запуске
   * (см. ScreenQualityModal) и запоминается для следующего раза. */
  screenHeight: ScreenHeight
  screenFps: ScreenFps
}

/** Высота картинки демонстрации. 0 — «как в источнике»: разрешение не
 * ограничиваем вовсе и отдаём то, что дал браузер. */
export type ScreenHeight = 0 | 720 | 1080 | 1440
export type ScreenFps = 15 | 30 | 60

/** Потолок битрейта под каждое сочетание высоты и частоты, бит/с.
 *
 * Нужен отдельно от разрешения: одни только constraints у getDisplayMedia
 * ограничивают КАРТИНКУ, а не поток — кодек всё равно раздуется на резком
 * движении, и 1080p60 без потолка легко уносит 15 Мбит/с в канал, где столько
 * нет. Значения — вдвое ниже «идеальных» из рекомендаций WebRTC: демонстрация
 * это чаще всего текст и интерфейс, а не видео.
 */
export function screenMaxBitrate(height: ScreenHeight, fps: ScreenFps): number {
  const base = height === 0 || height >= 1440 ? 6_000_000
    : height >= 1080 ? 3_000_000
    : 1_500_000
  // 60 кадров — примерно вдвое больше данных, 15 — примерно вдвое меньше.
  const factor = fps >= 60 ? 1.7 : fps <= 15 ? 0.6 : 1
  return Math.round(base * factor)
}

/** См. baseFontSize выше: во сколько раз масштабируются font-size в
 * index.css при выбранном значении (baseFontSize / FONT_SIZE_BASELINE). */
export const FONT_SIZE_BASELINE = 16
/** Отметки магнита для ползунка "Масштаб интерфейса" в SettingsModal. */
export const UI_SCALE_STEPS = [80, 90, 100, 110, 125, 150]
/** Отметки магнита для ползунка "Размер шрифта" в SettingsModal. */
export const FONT_SIZE_STEPS = [12, 13, 14, 15, 16, 17, 18, 19, 20]

export const DEFAULT_SETTINGS: Settings = {
  outputVolume: 1,
  micGain: 1,
  micThreshold: 0.035,
  theme: 'dark',
  preferMicMuted: false,
  preferDeafened: false,
  uiScale: 100,
  baseFontSize: FONT_SIZE_BASELINE,
  // Включено по умолчанию, но само по себе ничего не показывает: браузер всё
  // равно спросит разрешение, и до ответа уведомлений не будет (см.
  // notifications.ts). Просить разрешение при первой же загрузке — верный
  // способ получить «Блокировать» не глядя, поэтому спрашиваем по кнопке
  // в настройках.
  desktopNotifications: true,
  notificationSound: true,
  // 1080p/30 — то, что раньше получалось само: getDisplayMedia без
  // constraints обычно отдаёт разрешение экрана, а 30 кадров хватает всему,
  // кроме игр. Кто хочет иначе — меняет в модалке при запуске показа.
  screenHeight: 1080,
  screenFps: 30,
}

const STORAGE_KEY = 'pskovcord:settings'

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** 'system' не палитра сама по себе — резолвим в dark/light по ОС, у обоих
 * есть готовый [data-theme] блок (dark — это и есть значения :root). */
function resolveTheme(theme: ThemeChoice, prefersLight: boolean): Exclude<ThemeChoice, 'system'> {
  if (theme !== 'system') return theme
  return prefersLight ? 'light' : 'dark'
}

function applyTheme(theme: ThemeChoice, prefersLight: boolean) {
  const resolved = resolveTheme(theme, prefersLight)
  // dark совпадает со значениями :root по умолчанию — отдельный
  // [data-theme='dark'] блок не нужен, просто снимаем атрибут.
  if (resolved === 'dark') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', resolved)
}

/** zoom, а не transform: scale — реально пересчитывает layout (в т.ч. vh/vw
 * и брейкпоинты типа useIsMobile), а не рисует растянутую картинку поверх
 * старого layout'а, и не требует оборачивать всё приложение в отдельный div
 * с ручной компенсацией размеров под transform-origin. */
function applyUiScale(percent: number) {
  if (percent === 100) document.documentElement.style.removeProperty('zoom')
  else document.documentElement.style.setProperty('zoom', `${percent}%`)
}

function applyFontScale(px: number) {
  document.documentElement.style.setProperty('--font-scale', String(px / FONT_SIZE_BASELINE))
}

interface SettingsCtx extends Settings {
  setOutputVolume: (v: number) => void
  setMicGain: (v: number) => void
  setMicThreshold: (v: number) => void
  setTheme: (t: ThemeChoice) => void
  setPreferMicMuted: (v: boolean) => void
  setPreferDeafened: (v: boolean) => void
  setUiScale: (v: number) => void
  setBaseFontSize: (v: number) => void
  setDesktopNotifications: (v: boolean) => void
  setNotificationSound: (v: boolean) => void
  setScreenQuality: (height: ScreenHeight, fps: ScreenFps) => void
}

const Ctx = createContext<SettingsCtx>({
  ...DEFAULT_SETTINGS,
  setOutputVolume: () => {},
  setMicGain: () => {},
  setMicThreshold: () => {},
  setTheme: () => {},
  setPreferMicMuted: () => {},
  setPreferDeafened: () => {},
  setUiScale: () => {},
  setBaseFontSize: () => {},
  setDesktopNotifications: () => {},
  setNotificationSound: () => {},
  setScreenQuality: () => {},
})

export const useSettings = () => useContext(Ctx)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  // Применяем тему к <html> сразу и при смене выбора, а в режиме 'system' ещё
  // и живо реагируем на переключение тёмная/светлая в самой ОС, пока открыто
  // приложение — без этого пришлось бы перезагружать страницу.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    applyTheme(settings.theme, mq.matches)
    if (settings.theme !== 'system') return
    const onChange = (e: MediaQueryListEvent) => applyTheme('system', e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings.theme])

  useEffect(() => applyUiScale(settings.uiScale), [settings.uiScale])
  useEffect(() => applyFontScale(settings.baseFontSize), [settings.baseFontSize])

  const value: SettingsCtx = {
    ...settings,
    setOutputVolume: (v) => setSettings((s) => ({ ...s, outputVolume: v })),
    setMicGain: (v) => setSettings((s) => ({ ...s, micGain: v })),
    setMicThreshold: (v) => setSettings((s) => ({ ...s, micThreshold: v })),
    setTheme: (t) => setSettings((s) => ({ ...s, theme: t })),
    setPreferMicMuted: (v) => setSettings((s) => ({ ...s, preferMicMuted: v })),
    setPreferDeafened: (v) => setSettings((s) => ({ ...s, preferDeafened: v })),
    setUiScale: (v) => setSettings((s) => ({ ...s, uiScale: v })),
    setBaseFontSize: (v) => setSettings((s) => ({ ...s, baseFontSize: v })),
    setDesktopNotifications: (v) => setSettings((s) => ({ ...s, desktopNotifications: v })),
    setNotificationSound: (v) => setSettings((s) => ({ ...s, notificationSound: v })),
    setScreenQuality: (height, fps) =>
      setSettings((s) => ({ ...s, screenHeight: height, screenFps: fps })),
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
