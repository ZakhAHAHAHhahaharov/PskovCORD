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
}

export const DEFAULT_SETTINGS: Settings = {
  outputVolume: 1,
  micGain: 1,
  micThreshold: 0.035,
  theme: 'system',
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

interface SettingsCtx extends Settings {
  setOutputVolume: (v: number) => void
  setMicGain: (v: number) => void
  setMicThreshold: (v: number) => void
  setTheme: (t: ThemeChoice) => void
}

const Ctx = createContext<SettingsCtx>({
  ...DEFAULT_SETTINGS,
  setOutputVolume: () => {},
  setMicGain: () => {},
  setMicThreshold: () => {},
  setTheme: () => {},
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

  const value: SettingsCtx = {
    ...settings,
    setOutputVolume: (v) => setSettings((s) => ({ ...s, outputVolume: v })),
    setMicGain: (v) => setSettings((s) => ({ ...s, micGain: v })),
    setMicThreshold: (v) => setSettings((s) => ({ ...s, micThreshold: v })),
    setTheme: (t) => setSettings((s) => ({ ...s, theme: t })),
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
