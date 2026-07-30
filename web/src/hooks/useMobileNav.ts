import { useCallback, useEffect, useRef, useState } from 'react'

/** Мобильный layout: список каналов (nav) vs открытый канал (content), плюс
 * модалки поверх (настройки и т.п.) — на мобилке полноэкранные и тоже
 * закрываются "назад". На ПК всё видно разом (grid-колонки) или как обычная
 * модалка, isMobile здесь нужен только для истории браузера. */
export function useMobileNav(isMobile: boolean) {
  const [mobileScreen, setMobileScreen] = useState<'nav' | 'content'>('nav')
  // Стек "слоёв" мобильной навигации, каждый — одна pushState-запись в
  // истории браузера. Popstate снимает верхний слой и откатывает именно
  // его (закрывает то, что было открыто ПОСЛЕДНИМ — например настройки
  // поверх открытого канала — а не всегда возвращает на список каналов).
  const mobileBackStack = useRef<Array<() => void>>([])
  const pushMobileLayer = useCallback(
    (onPop: () => void) => {
      if (!isMobile) return
      history.pushState({ pskovcordMobile: true }, '')
      mobileBackStack.current.push(onPop)
    },
    [isMobile],
  )
  useEffect(() => {
    const onPopState = () => {
      const undo = mobileBackStack.current.pop()
      undo?.()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const goBackMobile = useCallback(() => {
    history.back()
  }, [])
  const navigateToContent = useCallback(() => {
    // Уже в content и просто переключились на другой канал/диалог — слой
    // истории не плодим, там нечего откатывать (мобильный "экран" тот же).
    if (!isMobile || mobileScreen === 'content') return
    pushMobileLayer(() => setMobileScreen('nav'))
    setMobileScreen('content')
  }, [isMobile, mobileScreen, pushMobileLayer])

  return { mobileScreen, pushMobileLayer, goBackMobile, navigateToContent }
}
