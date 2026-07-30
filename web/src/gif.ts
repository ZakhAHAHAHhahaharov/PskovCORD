/**
 * Разбор гифки на кадры — для выбора статичной картинки анимированного
 * аватара (см. GifAvatarModal).
 *
 * Основной путь — WebCodecs ImageDecoder: браузер сам разбирает GIF (включая
 * LZW, дельта-кадры и disposal-методы, которые вручную пришлось бы
 * реализовывать целиком) и отдаёт любой кадр по номеру. Есть в Chrome/Edge и
 * Electron, на котором живёт десктоп-клиент, а также в свежих Firefox.
 *
 * Запасной путь — для браузеров без ImageDecoder: число кадров считаем сами,
 * пробежав по блокам файла (это простой разбор структуры, без декодирования
 * пикселей), а выбрать можно только первый кадр — его умеет нарисовать
 * обычный <img> на canvas. Лучше, чем отказать в загрузке гифки вовсе.
 */

/** Один кадр, готовый к отрисовке в canvas. */
export interface GifFrame {
  image: CanvasImageSource
  width: number
  height: number
  /** Освободить кадр (VideoFrame держит память до явного close). */
  release: () => void
}

export interface GifFrames {
  count: number
  /** Кадр по номеру — источник для ctx.drawImage вместе с размерами. */
  frame: (index: number) => Promise<GifFrame>
  /** Можно ли выбирать произвольный кадр (false — доступен только первый). */
  seekable: boolean
  close: () => void
}

interface ImageDecoderLike {
  completed: Promise<void>
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } }
  decode: (opts: { frameIndex: number }) => Promise<{ image: DecodedFrame }>
  close: () => void
}

/** VideoFrame из WebCodecs — то, что отдаёт ImageDecoder.decode(). */
interface DecodedFrame {
  displayWidth: number
  displayHeight: number
  close: () => void
}

type ImageDecoderCtor = new (init: {
  data: ArrayBuffer | Uint8Array
  type: string
}) => ImageDecoderLike

function imageDecoderCtor(): ImageDecoderCtor | null {
  const ctor = (globalThis as unknown as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder
  return typeof ctor === 'function' ? ctor : null
}

/**
 * Сколько кадров в гифке — по структуре файла, без декодирования пикселей.
 *
 * Формат: заголовок (+ глобальная палитра), затем блоки. 0x2C — дескриптор
 * изображения (кадр), 0x21 — расширение (у него цепочка sub-блоков),
 * 0x3B — конец файла. Пиксели кадра лежат сжатыми LZW всё той же цепочкой
 * sub-блоков, так что пропустить кадр можно, ни разу его не распаковав.
 */
function countGifFrames(bytes: Uint8Array): number {
  // "GIF87a"/"GIF89a" + 7 байт логического экрана.
  let p = 6
  if (bytes.length < 13) return 0
  const flags = bytes[p + 4]
  p += 7
  // Глобальная таблица цветов, если объявлена: 3 байта на цвет.
  if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1))

  const skipSubBlocks = () => {
    while (p < bytes.length) {
      const size = bytes[p]
      p += 1
      if (size === 0) return
      p += size
    }
  }

  let frames = 0
  while (p < bytes.length) {
    const marker = bytes[p]
    p += 1
    if (marker === 0x3b) break // конец файла
    if (marker === 0x21) {
      p += 1 // метка расширения
      skipSubBlocks()
      continue
    }
    if (marker === 0x2c) {
      frames += 1
      // Дескриптор изображения: 8 байт геометрии + байт флагов.
      const localFlags = bytes[p + 8]
      p += 9
      if (localFlags & 0x80) p += 3 * (1 << ((localFlags & 0x07) + 1))
      p += 1 // минимальный размер LZW-кода
      skipSubBlocks()
      continue
    }
    // Мусор/непонятный маркер — дальше разбирать нечего.
    break
  }
  return frames
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Файл не похож на картинку.'))
    img.src = src
  })
}

/** Открыть гифку для покадрового просмотра. dataUrl — то же, что уедет на
 * сервер в avatar_anim. */
export async function openGif(dataUrl: string): Promise<GifFrames> {
  const bytes = dataUrlToBytes(dataUrl)
  const Ctor = imageDecoderCtor()
  if (Ctor) {
    const decoder = new Ctor({ data: bytes, type: 'image/gif' })
    await decoder.tracks.ready
    // completed гарантирует, что известно ИТОГОВОЕ число кадров: до полного
    // разбора файла frameCount растёт по мере чтения, и слайдер бы «дёргался».
    await decoder.completed
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1
    return {
      count: Math.max(1, count),
      frame: async (index: number) => {
        const { image } = await decoder.decode({ frameIndex: index })
        return {
          image: image as unknown as CanvasImageSource,
          width: image.displayWidth,
          height: image.displayHeight,
          release: () => image.close(),
        }
      },
      seekable: true,
      close: () => decoder.close(),
    }
  }
  // Запасной путь: кадры считаем, но отдать можем только первый.
  const img = await loadImageElement(dataUrl)
  return {
    count: Math.max(1, countGifFrames(bytes)),
    frame: async () => ({
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => {},
    }),
    seekable: false,
    close: () => {},
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Кадр → квадратный JPEG data-URL того же формата, что и обычный аватар
 * (кроп по центру, см. images.fileToSquareDataUrl) — именно он ложится в
 * avatar_image и показывается везде, где анимация не играет. */
export function frameToSquareDataUrl(frame: GifFrame, size: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas недоступен.')
  const side = Math.min(frame.width, frame.height)
  const sx = (frame.width - side) / 2
  const sy = (frame.height - side) / 2
  ctx.drawImage(frame.image, sx, sy, side, side, 0, 0, size, size)
  return canvas.toDataURL('image/jpeg', 0.85)
}
