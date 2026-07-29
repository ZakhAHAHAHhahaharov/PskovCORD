import { useState } from 'react'

// Открытие/закрытие синхронно по mouseenter/mouseleave, без задержки: зазор
// между строкой-триггером и флаутом перекрыт псевдоэлементом-мостом самого
// флаута (см. .status-flyout::before/.status-bubble-actions::before в
// index.css) — курсор в зазоре физически лежит над флаутом (его потомком в
// DOM), поэтому mouseleave обёртки там не срабатывает и без искусственной
// задержки. Без моста зазор — "мёртвая зона" ничья: курсор успевает выйти и
// из триггера, и из флаута, не долетев до кликабельного содержимого.
//
// Общий хук боковых/верхних флаутов по наведению — используется в
// StatusMenu.tsx (статус/переключение аккаунтов) и ProfileCardHeader.tsx
// (микро-меню над облачком статуса).
export function useHoverFlyout() {
  const [open, setOpen] = useState(false)
  return {
    open,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    close: () => setOpen(false),
  }
}
