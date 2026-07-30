/**
 * Общие помощники для картинок профиля/сервера: строгий формат градиента
 * баннера и подготовка файлов к отправке (аватар, значок сервера, гифка
 * баннера). Живут отдельно, потому что ровно то же самое нужно и карточке
 * профиля (ProfileModal), и редактору сервера (ServerSettingsModal) —
 * дублировать разбор градиента опасно: формат должен совпадать с тем, что
 * валидирует backend (GRADIENT_RE в accounts/serializers.py).
 */

export const GRADIENT_PRESETS: [string, string][] = [
  ['#5865f2', '#eb459e'],
  ['#23a55a', '#5865f2'],
  ['#f0b232', '#f23f43'],
  ['#8b5cf6', '#23a55a'],
  ['#1e1f22', '#5865f2'],
]

export const DEFAULT_GRADIENT_ANGLE = 135
export const DEFAULT_GRADIENT: [string, string] = ['#5865f2', '#eb459e']

/** Целевые разрешение и вес фона профиля/сервера (гифка или фото). Должны
 * совпадать с backend (accounts/serializers.py: MAX_BANNER_BYTES/
 * ALLOWED_BANNER_MIME). */
export const BANNER_MAX_W = 640
export const BANNER_MAX_H = 320
export const BANNER_MAX_BYTES = 4_000_000

/** Потолок на ИСХОДНЫЙ файл, который читаем в память перед сжатием (аватар,
 * значок сервера). Сам результат после кропа и JPEG-сжатия — десятки КБ, но
 * читать в память приходится оригинал целиком, а FileReader на файле в
 * сотни МБ подвешивает вкладку. */
export const SOURCE_IMAGE_MAX_BYTES = 20_000_000

/** Сторона квадрата аватара пользователя — держит data-URL небольшим
 * (десятки КБ): он летит в каждой строке ростера/сообщении. */
export const AVATAR_SIZE = 256
/** Значок сервера крупнее аватара: он один на сервер, а не на каждое
 * сообщение, и в ServerRail/карточке сервера виден заметно больше. */
export const SERVER_ICON_SIZE = 512

/** Разбирает `linear-gradient(<angle>deg, <hex> 0%, <hex> 100%)` обратно на
 * составляющие для полей редактирования; формат жёстко совпадает с тем, что
 * строит buildGradient (и с чем валидирует backend). */
export function parseGradient(css: string): { angle: number; from: string; to: string } {
  const m = /^linear-gradient\((\d{1,3})deg, (#[0-9a-fA-F]{6}) 0%, (#[0-9a-fA-F]{6}) 100%\)$/.exec(
    css,
  )
  if (!m) {
    return {
      angle: DEFAULT_GRADIENT_ANGLE,
      from: DEFAULT_GRADIENT[0],
      to: DEFAULT_GRADIENT[1],
    }
  }
  return { angle: Number(m[1]), from: m[2], to: m[3] }
}

export function buildGradient(angle: number, from: string, to: string): string {
  return `linear-gradient(${angle}deg, ${from} 0%, ${to} 100%)`
}

function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('Файл не похож на картинку.'))
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.src = dataUrl
  })
}

/** Готовит файл фона профиля/сервера (гифка или фото): гифку, которая и так
 * укладывается в лимиты, отдаёт как есть — canvas умеет отрисовать только
 * первый кадр, а перегонять через него означало бы гарантированно потерять
 * анимацию. Всё остальное (слишком большая гифка, любое фото) кроп-по-центру
 * ("cover", без искажения пропорций) до BANNER_MAX_W×BANNER_MAX_H и сжимает
 * в JPEG — так же, как fileToSquareDataUrl для аватара/значка, только
 * прямоугольный целевой размер вместо квадратного. */
export function fileToBannerDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > SOURCE_IMAGE_MAX_BYTES) {
      reject(
        new Error(
          `Файл слишком большой (макс. ${Math.round(SOURCE_IMAGE_MAX_BYTES / 1_000_000)} МБ).`,
        ),
      )
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.onload = async () => {
      const dataUrl = reader.result as string
      try {
        const { width, height } = await readImageSize(dataUrl)
        const fitsAsIs =
          file.type === 'image/gif' &&
          width <= BANNER_MAX_W &&
          height <= BANNER_MAX_H &&
          file.size <= BANNER_MAX_BYTES
        resolve(fitsAsIs ? dataUrl : await cropAndCompressBanner(dataUrl, width, height))
      } catch (err) {
        reject(err as Error)
      }
    }
    reader.readAsDataURL(file)
  })
}

function cropAndCompressBanner(dataUrl: string, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('Файл не похож на картинку.'))
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = BANNER_MAX_W
      canvas.height = BANNER_MAX_H
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas недоступен.'))
        return
      }
      // "cover": масштабируем по большей из сторон и обрезаем остаток по
      // центру, чтобы результат заполнил BANNER_MAX_W×BANNER_MAX_H целиком.
      const scale = Math.max(BANNER_MAX_W / width, BANNER_MAX_H / height)
      const sw = BANNER_MAX_W / scale
      const sh = BANNER_MAX_H / scale
      const sx = (width - sw) / 2
      const sy = (height - sh) / 2
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, BANNER_MAX_W, BANNER_MAX_H)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.src = dataUrl
  })
}

/** Потолок на гифку-аватар. Должен совпадать с backend
 * (accounts/serializers.py MAX_AVATAR_ANIM_BYTES): в отличие от статики её
 * нечем сжать — перекодировать анимацию в браузере не получится, — поэтому
 * единственный рычаг это вес исходного файла. */
export const AVATAR_ANIM_MAX_BYTES = 4_000_000

/** Читает гифку как есть, без единой попытки её сжать: canvas умеет
 * нарисовать только текущий кадр, и любой прогон через него означал бы
 * потерю анимации. Отсюда и жёсткая проверка веса — уменьшить файл, если он
 * не влез, нам нечем, остаётся честно сказать об этом. */
export function fileToGifDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > AVATAR_ANIM_MAX_BYTES) {
      reject(
        new Error(
          `Гифка слишком большая (макс. ${Math.round(AVATAR_ANIM_MAX_BYTES / 1_000_000)} МБ). ` +
            'Уменьшите её размер или число кадров.',
        ),
      )
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

/** Читает файл, кроп по центру до квадрата и сжимает в JPEG data-URL —
 * и для аватара пользователя, и для значка сервера (разный только размер). */
export function fileToSquareDataUrl(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Проверка веса ДО чтения в память. Соседняя fileToBannerDataUrl это
    // делает, а здесь не делалось: accept="image/*" ограничением не является,
    // и файл на сотни мегабайт читался целиком через FileReader — вкладка
    // подвисала или падала ещё до того, как дело доходило до сжатия.
    if (file.size > SOURCE_IMAGE_MAX_BYTES) {
      reject(
        new Error(
          `Файл слишком большой (макс. ${Math.round(SOURCE_IMAGE_MAX_BYTES / 1_000_000)} МБ).`,
        ),
      )
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Файл не похож на картинку.'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Canvas недоступен.'))
          return
        }
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - side) / 2
        const sy = (img.naturalHeight - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}
