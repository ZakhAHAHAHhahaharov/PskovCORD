import { useEffect, useRef, useState } from 'react'
import { Sticker, mediaUrl } from '../api'
import { stickerStore, useStickerVersion } from '../stickers'

/**
 * Стикер — единственное место, где он превращается в пиксели.
 *
 * Главное здесь то же, что и у кастомных эмодзи (см. CustomEmojiImage):
 * анимация НЕ играет сама по себе. Только вместо «десятки штук на экране»
 * причина другая — стикер большой, и лента, где одновременно крутится
 * десяток анимаций, превращается в мельтешение, в котором не прочитать текст.
 * Поэтому анимированный стикер:
 *
 *   * в сетке пикера не играет вообще (play="never") — там на него смотрят,
 *     чтобы выбрать, а не чтобы посмотреть;
 *   * в ленте играет, пока на сообщение наведён курсор (play="hover"), и
 *     один раз сразу после появления (autoPlay) — то есть у отправителя и у
 *     собеседника стикер «оживает» ровно в момент отправки.
 *
 * Три формата — три способа рисовать, и это единственное место, где о такой
 * разнице кто-то знает:
 *
 *   webp   — <img>. Анимированный файл рисуется ПОВЕРХ статичного кадра, а не
 *            подменяет ему src: подмена дала бы дырку на время загрузки.
 *   lottie — векторная анимация, её проигрывает lottie-web. Библиотека
 *            подгружается динамическим import'ом: она весит заметно больше
 *            всего остального в бандле, а Lottie-стикеры есть далеко не у
 *            каждого.
 *   webm   — <video> без звука. Первый кадр показывается сам, как только
 *            догрузились данные, поэтому отдельный статичный файл ему не
 *            нужен (см. backend StickerSerializer.get_static_url).
 */

/** Сколько играет автозапуск при появлении стикера в ленте. Не «один цикл»:
 * длительность анимации нам неизвестна (у webm её знает только плеер, у
 * Lottie — только библиотека), а четырёх секунд хватает и на короткую
 * зацикленную, и на длинную одиночную. */
const AUTOPLAY_MS = 4000

export default function StickerImage({
  id,
  sticker: given,
  size,
  play = 'hover',
  autoPlay = false,
  /** Внешняя команда играть — например, наведение на всё сообщение целиком, а
   * не на сам стикер (см. MessageList). */
  playing = false,
}: {
  id: number
  /** Готовый объект, если он уже на руках (сетка пикера) — чтобы не ходить в
   * реестр на каждый из сотни стикеров. */
  sticker?: Sticker
  size: number
  play?: 'hover' | 'never'
  autoPlay?: boolean
  playing?: boolean
}) {
  // Подписка на реестр: стикер мог ещё не доехать на момент первого рендера
  // (lookup поставил его в очередь).
  useStickerVersion()
  const sticker = given ?? stickerStore.lookup(id)

  const [hovered, setHovered] = useState(false)
  const [autoPlaying, setAutoPlaying] = useState(autoPlay)
  useEffect(() => {
    if (!autoPlay) return
    const timer = setTimeout(() => setAutoPlaying(false), AUTOPLAY_MS)
    return () => clearTimeout(timer)
  }, [autoPlay])

  const active =
    Boolean(sticker?.animated) &&
    (autoPlaying || playing || (play === 'hover' && hovered))

  if (!sticker) {
    // Стикер удалили с сервера (или он с сервера, которого мы не видим).
    // Заглушка размером с сам стикер, а не пустота: иначе сообщение выглядит
    // просто пропавшим.
    return (
      <span className="sticker sticker-missing" style={{ width: size, height: size }}>
        Стикер удалён
      </span>
    )
  }

  return (
    <span
      className="sticker"
      style={{ width: size, height: size }}
      title={sticker.name}
      onMouseEnter={play === 'hover' ? () => setHovered(true) : undefined}
      onMouseLeave={play === 'hover' ? () => setHovered(false) : undefined}
    >
      {sticker.format === 'lottie' ? (
        <LottieSticker sticker={sticker} active={active} />
      ) : sticker.format === 'webm' ? (
        <WebmSticker sticker={sticker} active={active} />
      ) : (
        <WebpSticker sticker={sticker} active={active} />
      )}
    </span>
  )
}

function WebpSticker({ sticker, active }: { sticker: Sticker; active: boolean }) {
  // Догрузился ли анимированный файл. Пока false — он прозрачен, и виден
  // статичный кадр под ним (иначе стикер мигал бы дыркой на каждое наведение).
  const [animLoaded, setAnimLoaded] = useState(false)
  const still = sticker.static_url || sticker.url
  return (
    <>
      <img className="sticker-still" src={mediaUrl(still)} alt={sticker.name}
        loading="lazy" draggable={false} />
      {active && (
        <img
          className="sticker-anim"
          style={{ opacity: animLoaded ? 1 : 0 }}
          src={mediaUrl(sticker.url)}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => setAnimLoaded(true)}
        />
      )}
    </>
  )
}

function WebmSticker({ sticker, active }: { sticker: Sticker; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (active) {
      // play() возвращает промис и отклоняется, если элемент успели убрать со
      // страницы, — обычное дело при быстром уводе мыши, и ошибкой это не
      // является.
      void video.play().catch(() => {})
    } else {
      video.pause()
      video.currentTime = 0
    }
  }, [active])
  return (
    <video
      ref={ref}
      className="sticker-video"
      src={mediaUrl(sticker.url)}
      // metadata мало: нужен первый КАДР, а не только размеры, иначе стикер
      // до первого наведения оставался бы чёрным прямоугольником.
      preload="auto"
      muted
      loop
      playsInline
      draggable={false}
    />
  )
}

function LottieSticker({ sticker, active }: { sticker: Sticker; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Тип библиотеки не импортируем: она приезжает динамическим import'ом, и
  // ради одного поля тянуть её типы в статический граф незачем.
  const animRef = useRef<{ play: () => void; goToAndStop: (v: number, f?: boolean) => void
    destroy: () => void } | null>(null)
  // Библиотека и сам файл анимации приезжают асинхронно и запросто позже, чем
  // стикер попросят играть (автозапуск при появлении в ленте — это первый же
  // рендер). Без этого ref'а такой запуск просто терялся бы: эффект ниже
  // отработал бы на пустом animRef и больше не повторился.
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // lottie_light — сборка без выражений (expressions): они умеют
      // выполнять код из файла анимации, а нам это и не нужно, и не хочется.
      const { default: lottie } = await import('lottie-web/build/player/lottie_light')
      if (cancelled || !containerRef.current) return
      animRef.current = lottie.loadAnimation({
        container: containerRef.current,
        renderer: 'svg',
        loop: true,
        // Первый кадр рисуется сразу, дальше ждём команды — см. эффект ниже.
        autoplay: false,
        path: mediaUrl(sticker.url),
      })
      if (activeRef.current) animRef.current.play()
    })()
    return () => {
      cancelled = true
      animRef.current?.destroy()
      animRef.current = null
    }
  }, [sticker.url])

  useEffect(() => {
    const anim = animRef.current
    if (!anim) return
    if (active) anim.play()
    // true — «перерисовать сразу»: без него остановленная анимация замирает на
    // текущем кадре, а не возвращается на первый.
    else anim.goToAndStop(0, true)
  }, [active])

  return <div ref={containerRef} className="sticker-lottie" />
}
