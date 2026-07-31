import { ReactNode, useLayoutEffect, useRef, useState } from 'react'

/** Скорость бега — пикселей в секунду. Медленно и читаемо: строка не длинная
 * (имя + подпись оригинального ника), гонять её быстрее незачем. */
const PIXELS_PER_SECOND = 30

/**
 * Строка, которая уезжает бегущей строкой, ТОЛЬКО если не помещается в
 * отведённую ширину. Помещается — обычный текст, без анимации вовсе.
 *
 * Нужна для имени друга с подписью оригинального ника (`Никнейм username*`,
 * см. nicknames.ts): в узкой строке сайдбара такая пара часто не влезает, а
 * обрезать её многоточием — значит спрятать ровно ту часть, ради которой
 * подпись и добавлена.
 *
 * Ходит туда-обратно (animation-direction: alternate), а не по кругу: у
 * кольцевой бегущей строки нужен дубль текста, иначе на стыке зияет пустота,
 * а дубль в списке имён читается как второй человек.
 */
export default function ScrollingText({
  children,
  className = '',
  /** Текст, при изменении которого замер нужно повторить — сам children
   * может быть тем же деревом с другим содержимым внутри. */
  measureKey,
}: {
  children: ReactNode
  className?: string
  measureKey?: string
}) {
  const outerRef = useRef<HTMLSpanElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)

  // Замер после отрисовки: ширина зависит от шрифта ника (он может быть
  // кастомным и подгружаться асинхронно, см. useNameFonts) и от ширины
  // самого сайдбара, поэтому пересчитываем и на ресайз контейнера.
  useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return
    const measure = () => {
      const overflow = inner.scrollWidth - outer.clientWidth
      // Порог в пару пикселей — субпиксельные округления иначе включают
      // анимацию на строке, которая визуально помещается целиком.
      setShift(overflow > 2 ? overflow : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [measureKey])

  return (
    <span
      ref={outerRef}
      className={`scrolling-text ${shift ? 'scrolling-text-run' : ''} ${className}`}
      style={
        shift
          ? {
              // Пауза на краях заложена в сами keyframes (см. index.css),
              // поэтому длительность считаем с запасом на неё.
              ['--scroll-shift' as string]: `${-shift}px`,
              ['--scroll-duration' as string]: `${(shift / PIXELS_PER_SECOND + 2).toFixed(1)}s`,
            }
          : undefined
      }
    >
      <span ref={innerRef} className="scrolling-text-inner">
        {children}
      </span>
    </span>
  )
}
