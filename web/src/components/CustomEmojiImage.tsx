import { useState } from 'react'
import { CustomEmoji, mediaUrl } from '../api'
import { customEmojiStore, useCustomEmojiVersion } from '../customEmoji'

/**
 * Кастомный эмодзи — единственное место, где он превращается в пиксели.
 *
 * Главное здесь — анимация НЕ играет сама по себе. Экран чата легко набирает
 * пару десятков анимированных эмодзи (лента реакций + текст + сетка пикера), и
 * все они, крутясь одновременно, дают дёргающийся интерфейс и заметно жрут
 * батарею на ноутбуке — при том, что смотрят в конкретный момент на один.
 * Поэтому по умолчанию виден статичный первый кадр (static_url, вырезан при
 * загрузке — см. gif.ts), а сам GIF/WEBP подгружается только когда:
 *
 *   * на эмодзи навели — в тексте сообщения и в сетке пикера (play="hover");
 *   * по нему нажали — в ленте реакций (play="none" + внешний playing).
 *     Наведение там не годится: мышь проходит по пилюлям транзитом, к чужой
 *     реакции подводят, чтобы прочитать подсказку «кто поставил», а не чтобы
 *     смотреть анимацию.
 *
 * Анимированный файл рисуется ПОВЕРХ статичного, а не подменяет ему src:
 * подмена дала бы пустое место на время загрузки, то есть эмодзи мигал бы
 * дыркой при каждом наведении.
 */

export default function CustomEmojiImage({
  id,
  emoji: given,
  size,
  play = 'hover',
  playing = false,
  className = '',
}: {
  /** id эмодзи; сам объект берётся из реестра (и дозагружается, если его там
   * ещё нет — см. customEmojiStore.lookup). */
  id: number
  /** Готовый объект — если он уже на руках (сетка пикера, редактор сервера),
   * чтобы не ходить в реестр на каждый из сотни эмодзи. */
  emoji?: CustomEmoji
  /** Сторона в пикселях; без неё размер задаётся классом снаружи. */
  size?: number
  /** Когда играть анимацию: по наведению или только по внешней команде. */
  play?: 'hover' | 'none'
  /** Внешняя команда играть — для реакций, где триггер это клик по пилюле. */
  playing?: boolean
  className?: string
}) {
  // Подписка на реестр: эмодзи мог ещё не доехать на момент первого рендера
  // (lookup поставил его в очередь) — без неё картинка так и осталась бы
  // заглушкой до следующего случайного перерендера.
  useCustomEmojiVersion()
  const emoji = given ?? customEmojiStore.lookup(id)

  const [hovered, setHovered] = useState(false)
  // Анимированный файл догрузился и его можно показывать. Пока false — поверх
  // статичного лежит прозрачная картинка, и видно статичный кадр.
  const [animLoaded, setAnimLoaded] = useState(false)

  if (!emoji) {
    // Эмодзи удалили с сервера (или он с сервера, которого мы не видим).
    // Заглушка, а не пустота: иначе рядом стоящий счётчик реакции выглядит
    // сломанным. Тот же символ, что и в MessageReactions до этой правки.
    return <span className={`custom-emoji-missing ${className}`}>□</span>
  }

  const active = emoji.animated && (playing || (play === 'hover' && hovered))
  const boxStyle = size ? { width: size, height: size } : undefined

  return (
    <span
      className={`custom-emoji ${className}`}
      style={boxStyle}
      title={`:${emoji.name}:`}
      onMouseEnter={play === 'hover' ? () => setHovered(true) : undefined}
      onMouseLeave={
        play === 'hover'
          ? () => {
              setHovered(false)
              // Сбрасываем и «загружено»: следующее наведение должно начать
              // анимацию с первого кадра, а не подхватить её с середины.
              setAnimLoaded(false)
            }
          : undefined
      }
    >
      <img
        className="custom-emoji-still"
        src={mediaUrl(emoji.static_url)}
        alt={`:${emoji.name}:`}
        draggable={false}
      />
      {active && (
        <img
          className="custom-emoji-anim"
          style={{ opacity: animLoaded ? 1 : 0 }}
          src={mediaUrl(emoji.url)}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => setAnimLoaded(true)}
        />
      )}
    </span>
  )
}
