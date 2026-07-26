import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const STORAGE_KEY = 'userVolumes'
const DEFAULT_VOLUME = 1

function loadStored(): Record<number, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export interface UserVolume {
  /** 0..2 (0–200%, как в Discord), 1 — дефолт (100%). */
  getUserVolume: (userId: number) => number
  setUserVolume: (userId: number, volume: number) => void
}

const EMPTY: UserVolume = { getUserVolume: () => DEFAULT_VOLUME, setUserVolume: () => {} }

export const UserVolumeCtx = createContext<UserVolume>(EMPTY)
export const useUserVolume = () => useContext(UserVolumeCtx)

/**
 * Локальная громкость конкретного участника голосового канала — видна и
 * действует только у себя (не влияет на то, что слышат остальные), в
 * дополнение к общей outputVolume из настроек (settings.tsx) — оба множатся
 * при применении к <audio>.volume, см. VoiceProvider.tsx. Персистится в
 * localStorage (в отличие от, например, блокировки зрителей демонстрации,
 * см. voice.ts) — это личная настройка звука конкретного человека, как в
 * Discord переживает переподключение/перезаход.
 */
export function useUserVolumeState(): UserVolume {
  const [volumes, setVolumes] = useState<Record<number, number>>(loadStored)

  const getUserVolume = useCallback(
    (userId: number) => volumes[userId] ?? DEFAULT_VOLUME,
    [volumes],
  )

  const setUserVolume = useCallback((userId: number, volume: number) => {
    setVolumes((prev) => {
      const next = { ...prev, [userId]: volume }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage недоступен (приватный режим и т.п.) — просто не персистим.
      }
      return next
    })
  }, [])

  return useMemo(() => ({ getUserVolume, setUserVolume }), [getUserVolume, setUserVolume])
}
