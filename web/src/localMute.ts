import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const STORAGE_KEY = 'locallyMutedUsers'

function loadStored(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number') : []
  } catch {
    return []
  }
}

export interface LocalMute {
  /** «Отключить звук для себя» из ParticipantContextMenu — глушит участника
   * ТОЛЬКО в моём плеере (в отличие от «Голосование за мут», которое реально
   * выключает микрофон у всех), сам он остаётся размьюченным для остальных. */
  isLocallyMuted: (userId: number) => boolean
  setLocallyMuted: (userId: number, value: boolean) => void
}

const EMPTY: LocalMute = { isLocallyMuted: () => false, setLocallyMuted: () => {} }

export const LocalMuteCtx = createContext<LocalMute>(EMPTY)
export const useLocalMute = () => useContext(LocalMuteCtx)

/**
 * Персистится в localStorage (тот же приём, что userVolume.ts/hiddenNames.ts)
 * — личная настройка звука конкретного человека, переживает переподключение/
 * перезаход и никак не синхронизируется с сервером. Отдельный флаг, а не
 * "громкость = 0" в userVolume.ts — так включение звука обратно возвращает
 * прежнюю громкость, а не сбрасывает её на 100%.
 */
export function useLocalMuteState(): LocalMute {
  const [ids, setIds] = useState<number[]>(loadStored)

  const isLocallyMuted = useCallback((userId: number) => ids.includes(userId), [ids])

  const setLocallyMuted = useCallback((userId: number, value: boolean) => {
    setIds((prev) => {
      const next = value ? [...new Set([...prev, userId])] : prev.filter((id) => id !== userId)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage недоступен — просто не персистим.
      }
      return next
    })
  }, [])

  return useMemo(() => ({ isLocallyMuted, setLocallyMuted }), [isLocallyMuted, setLocallyMuted])
}
