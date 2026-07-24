import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

/** Локальные настройки устройства — не синхронизируются с сервером, живут в localStorage. */
export interface Settings {
  /** Громкость входящего звука (голос собеседников + звук демонстрации), 0..1. */
  outputVolume: number
  /** Усиление своего микрофона перед отправкой, 0..2 (1 — без изменений). */
  micGain: number
  /** Порог RMS, с которого микрофон считается "говорящим" (индикатор + кольцо). */
  micThreshold: number
}

export const DEFAULT_SETTINGS: Settings = {
  outputVolume: 1,
  micGain: 1,
  micThreshold: 0.035,
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

interface SettingsCtx extends Settings {
  setOutputVolume: (v: number) => void
  setMicGain: (v: number) => void
  setMicThreshold: (v: number) => void
}

const Ctx = createContext<SettingsCtx>({
  ...DEFAULT_SETTINGS,
  setOutputVolume: () => {},
  setMicGain: () => {},
  setMicThreshold: () => {},
})

export const useSettings = () => useContext(Ctx)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const value: SettingsCtx = {
    ...settings,
    setOutputVolume: (v) => setSettings((s) => ({ ...s, outputVolume: v })),
    setMicGain: (v) => setSettings((s) => ({ ...s, micGain: v })),
    setMicThreshold: (v) => setSettings((s) => ({ ...s, micThreshold: v })),
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
