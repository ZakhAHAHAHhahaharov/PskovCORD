import { useEffect, useState } from 'react'
import { api, NameFont } from '../api'

// Модульный кэш вместо React Query/SWR — один и тот же промис переживает
// сколько угодно вызовов useNameFonts() по всему приложению (AppShell —
// просто чтобы прогреть @font-face пораньше, DisplayNameStyleModal — чтобы
// нарисовать карточки выбора), запрос к /api/auth/name-fonts уходит один раз.
let fontsPromise: Promise<NameFont[]> | null = null
const injectedIds = new Set<number>()
const STYLE_EL_ID = 'pc-name-fonts'

// Подсказка браузеру про формат по расширению файла — не обязательна (браузер
// и так умеет посмотреть на сам файл), но чуть ускоряет выбор шрифта, когда
// сервер отдаёт несколько форматов одного шрифта (тут не отдаёт, но не вредит).
function formatHint(url: string): string {
  if (url.endsWith('.woff2')) return "format('woff2')"
  if (url.endsWith('.woff')) return "format('woff')"
  if (url.endsWith('.ttf')) return "format('truetype')"
  return ''
}

/** Раз объявленный @font-face НЕ скачивает файл сам по себе — браузер тянет
 * его лениво, только когда font-family реально применяется к видимому
 * тексту. Поэтому декларировать все шрифты каталога разом (даже те, что
 * сейчас никто не видит) безопасно и дёшево. */
function ensureFontFacesInjected(fonts: NameFont[]) {
  const toAdd = fonts.filter((f) => !injectedIds.has(f.id))
  if (toAdd.length === 0) return
  let styleEl = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_EL_ID
    document.head.appendChild(styleEl)
  }
  for (const font of toAdd) {
    styleEl.appendChild(
      document.createTextNode(
        `@font-face { font-family: 'pc-namefont-${font.id}'; ` +
          `src: url(${JSON.stringify(font.file)}) ${formatHint(font.file)}; ` +
          `font-display: swap; }`,
      ),
    )
    injectedIds.add(font.id)
  }
}

/** Каталог шрифтов ника (см. accounts.models.NameFont) — грузится один раз на
 * всё приложение и инжектит @font-face по мере получения списка. Возвращает
 * пустой массив, пока грузится (или если запрос упал — тогда просто нечего
 * предложить в пикере, системный шрифт остаётся доступен всегда). */
export function useNameFonts(): NameFont[] {
  const [fonts, setFonts] = useState<NameFont[]>([])

  useEffect(() => {
    if (!fontsPromise) fontsPromise = api.nameFonts().catch(() => [])
    let cancelled = false
    fontsPromise.then((list) => {
      if (cancelled) return
      ensureFontFacesInjected(list)
      setFonts(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return fonts
}
