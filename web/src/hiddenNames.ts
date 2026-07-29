import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const STORAGE_KEY = 'hiddenNameChannels'

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

export interface HiddenNames {
  /** «Скрыть имена» включено лично у меня для этого голосового канала —
   * маскирует ники ВСЕХ участников до вида «А....» (только у себя в
   * интерфейсе, остальные видят как обычно). */
  isHidden: (channelId: number) => boolean
  setHidden: (channelId: number, value: boolean) => void
}

const EMPTY: HiddenNames = { isHidden: () => false, setHidden: () => {} }

export const HiddenNamesCtx = createContext<HiddenNames>(EMPTY)
export const useHiddenNames = () => useContext(HiddenNamesCtx)

/** name[0] + точки — формат из задачи ("А...."), фиксированная длина, чтобы
 * не выдавать длину настоящего ника. */
export function maskName(name: string): string {
  const first = name.trim().charAt(0) || '?'
  return `${first}....`
}

/**
 * Персистится в localStorage (см. userVolume.ts — тот же приём) — личная
 * настройка отображения конкретного голосового канала, переживает
 * перезаход/переподключение, никак не синхронизируется с сервером и не
 * влияет на то, что видят остальные.
 */
export function useHiddenNamesState(): HiddenNames {
  const [ids, setIds] = useState<number[]>(loadStored)

  const isHidden = useCallback((channelId: number) => ids.includes(channelId), [ids])

  const setHidden = useCallback((channelId: number, value: boolean) => {
    setIds((prev) => {
      const next = value ? [...new Set([...prev, channelId])] : prev.filter((id) => id !== channelId)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage недоступен — просто не персистим.
      }
      return next
    })
  }, [])

  return useMemo(() => ({ isHidden, setHidden }), [isHidden, setHidden])
}
