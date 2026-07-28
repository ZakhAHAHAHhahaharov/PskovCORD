import { useEffect, useState } from 'react'

/** true при ширине вьюпорта не больше breakpoint — единственный источник
 * правды для мобильного layout'а в JS (навигация в AppShell). Синхронен с
 * `@media (max-width: 768px)` в index.css — значение по умолчанию то же,
 * при изменении держать оба места в согласии вручную. */
export function useIsMobile(breakpoint = 768): boolean {
  const query = `(max-width: ${breakpoint}px)`
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return isMobile
}
