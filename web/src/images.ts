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

/** Максимальное разрешение и вес гифки-баннера. Гифку нельзя пережать на
 * клиенте без потери анимации (canvas хватает только первый кадр), поэтому
 * вместо сжатия — просто валидация. Должны совпадать с backend
 * (accounts/serializers.py: MAX_BANNER_BYTES/ALLOWED_BANNER_MIME). */
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

/** Читает файл баннера как есть (без пережатия — см. BANNER_MAX_W) и
 * проверяет вес и разрешение. */
export function fileToBannerDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > BANNER_MAX_BYTES) {
      reject(
        new Error(`Файл слишком большой (макс. ${Math.round(BANNER_MAX_BYTES / 1_000_000)} МБ).`),
      )
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.onload = async () => {
      const dataUrl = reader.result as string
      try {
        const { width, height } = await readImageSize(dataUrl)
        if (width > BANNER_MAX_W || height > BANNER_MAX_H) {
          reject(
            new Error(
              `Слишком большое разрешение — макс. ${BANNER_MAX_W}×${BANNER_MAX_H}, а тут ${width}×${height}.`,
            ),
          )
          return
        }
        resolve(dataUrl)
      } catch (err) {
        reject(err as Error)
      }
    }
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
