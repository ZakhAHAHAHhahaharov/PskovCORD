import { Loader2, WifiOff } from 'lucide-react'
import { useConnectionState } from '../gateway'

/** Полоса «связь потеряна» поверх всего приложения.
 *
 * До неё обрыв gateway'я не показывался вообще: у голоса индикатор был (см.
 * SidebarBottomBar, voice-signal), а у основного сокета — нет. Снаружи это
 * выглядело так, будто чат просто затих, и единственной понятной реакцией
 * была перезагрузка страницы — хотя реконнект и так идёт сам.
 *
 * Показываем только 'offline', то есть когда попытки проваливаются подряд
 * (см. gateway.tsx): моргнувший на секунду вайфай чинится быстрее, чем
 * человек успевает прочитать полосу, и мигать ею на каждый рестарт бэкенда
 * незачем. */
export default function ConnectionBanner() {
  const state = useConnectionState()
  if (state !== 'offline') return null
  return (
    <div className="connection-banner" role="status" aria-live="polite">
      <WifiOff size={14} />
      <span>Соединение потеряно</span>
      <Loader2 size={14} className="spin" />
      <span className="connection-banner-hint">переподключаемся…</span>
    </div>
  )
}
