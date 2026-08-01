import { useEffect, useState } from 'react'
import { Bug } from 'lucide-react'
import BugReportModal from './BugReportModal'

/**
 * Держит в CSS-переменной актуальную высоту поля ввода сообщения.
 *
 * На мобильной раскладке композер занимает всю нижнюю полосу и РАСТЁТ по
 * мере набора: при трёх строках он поднимается на 90px, при шести — на 156.
 * Фиксированный отступ снизу тут не работает в принципе — проверено
 * замером: кнопка с bottom:74px оказывалась под композером уже на третьей
 * строке. Поэтому отступ считается от его настоящей высоты.
 *
 * Наблюдаем сами, а не просим композер сообщать о себе: связь односторонняя
 * и необязательная — там, где поля ввода нет вовсе (экран входа, 404),
 * переменная просто остаётся пустой и работает запасное значение из CSS.
 */
function useComposerHeight() {
  useEffect(() => {
    const root = document.documentElement
    const apply = (height: number) => {
      root.style.setProperty('--composer-height', `${Math.round(height)}px`)
    }
    let observer: ResizeObserver | null = null
    let composer: Element | null = null

    const attach = () => {
      const found = document.querySelector('.message-input')
      if (found === composer) return
      composer = found
      observer?.disconnect()
      if (!found) {
        root.style.removeProperty('--composer-height')
        return
      }
      observer = new ResizeObserver(([entry]) => apply(entry.contentRect.height))
      observer.observe(found)
      apply(found.getBoundingClientRect().height)
    }

    attach()
    // Композер появляется и исчезает вместе с открытым каналом, поэтому
    // следим за его появлением в дереве, а не ищем один раз при монтировании.
    const mutations = new MutationObserver(attach)
    mutations.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer?.disconnect()
      mutations.disconnect()
      root.style.removeProperty('--composer-height')
    }
  }, [])
}

/**
 * Кнопка «сообщить о проблеме» в правом нижнем углу — единственный элемент
 * приложения, видимый вообще всегда, включая экран входа: человек, у
 * которого не выходит войти, пожаловаться из-под входа иначе не может, а это
 * как раз тот, кому помощь нужнее всего.
 *
 * z-index намеренно НИЖЕ модального оверлея (100): открытый диалог должен
 * накрывать кнопку своим фоном сам, без отдельной логики «спрятаться». В
 * противном случае пришлось бы отслеживать каждый попап и лайтбокс
 * по отдельности, и любой новый забыли бы учесть.
 *
 * Само модальное окно рендерится отсюда же: держать его состояние выше
 * незачем — им никто, кроме этой кнопки, не управляет.
 */
export default function BugReportButton() {
  const [open, setOpen] = useState(false)
  useComposerHeight()

  return (
    <>
      <button
        type="button"
        className="bug-report-fab"
        title="Сообщить о проблеме"
        aria-label="Сообщить о проблеме"
        onClick={() => setOpen(true)}
      >
        <Bug size={18} />
      </button>
      {open && <BugReportModal onClose={() => setOpen(false)} />}
    </>
  )
}
