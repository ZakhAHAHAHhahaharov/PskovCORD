import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import { AVATAR_SIZE } from '../images'
import { GifFrames, frameToSquareDataUrl, openGif } from '../gif'

/**
 * Редактор анимированного (гифка) аватара — открывается сразу после выбора
 * .gif в профиле (см. ProfileModal.handleFileChange).
 *
 * Гифка сохраняется КАК ЕСТЬ (перекодировать анимацию в браузере нечем), а
 * вдобавок к ней выбирается один кадр: именно он лежит в обычном avatar_image
 * и виден везде, где анимация не играет — а играет она только когда человек
 * говорит в голосовом, когда навели курсор на его сообщение и в карточке
 * профиля (см. avatarAnim.ts). По умолчанию берётся серединный кадр: первый у
 * гифок часто пустой/затемнённый — заставка перед началом движения.
 *
 * Второй переключатель — «можно ли другим скачивать аватар»
 * (accounts.models.User.avatar_downloadable). Это вежливость, а не защита:
 * картинка всё равно приезжает в браузер каждому, кто видит профиль.
 */
export default function GifAvatarModal({
  gifDataUrl,
  initialFrame,
  initialDownloadable,
  onSave,
  onClose,
}: {
  /** Уже прочитанная гифка (data-URL) — ровно то, что уедет в avatar_anim. */
  gifDataUrl: string
  /** Кадр, выбранный в прошлый раз (при повторном редактировании). */
  initialFrame?: number
  initialDownloadable?: boolean
  onSave: (data: {
    avatar_image: string
    avatar_anim: string
    avatar_frame: number
    avatar_downloadable: boolean
  }) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const gifRef = useRef<GifFrames | null>(null)
  const [frames, setFrames] = useState<number | null>(null)
  const [seekable, setSeekable] = useState(true)
  const [frame, setFrame] = useState(0)
  const [preview, setPreview] = useState('')
  const [downloadable, setDownloadable] = useState(initialDownloadable ?? true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Разбор гифки — один раз на открытие модалки. Декодер держит буфер кадров,
  // поэтому его обязательно закрывать при уходе, иначе память живёт до конца
  // жизни вкладки.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const gif = await openGif(gifDataUrl)
        if (cancelled) {
          gif.close()
          return
        }
        gifRef.current = gif
        setFrames(gif.count)
        setSeekable(gif.seekable)
        // Серединный кадр по умолчанию; при повторном редактировании —
        // тот, что уже выбран, если он всё ещё существует.
        const start =
          initialFrame != null && initialFrame < gif.count
            ? initialFrame
            : Math.floor(gif.count / 2)
        setFrame(gif.seekable ? start : 0)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
      gifRef.current?.close()
      gifRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gifDataUrl])

  // Превью выбранного кадра — та же квадратная картинка, что уедет на сервер
  // (не отдельная отрисовка): что видно в модалке, то и станет аватаром.
  useEffect(() => {
    const gif = gifRef.current
    if (!gif || frames === null) return
    let cancelled = false
    void (async () => {
      try {
        const decoded = await gif.frame(Math.min(frame, gif.count - 1))
        try {
          if (!cancelled) setPreview(frameToSquareDataUrl(decoded, AVATAR_SIZE))
        } finally {
          decoded.release()
        }
      } catch {
        // Отдельный кадр не декодировался — оставляем предыдущее превью,
        // ронять весь редактор из-за одного кадра незачем.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [frame, frames])

  const handleSave = async () => {
    if (!preview) return
    setSaving(true)
    setError('')
    try {
      await onSave({
        avatar_image: preview,
        avatar_anim: gifDataUrl,
        avatar_frame: frame,
        avatar_downloadable: downloadable,
      })
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Анимированный аватар</h2>

        <div className="gif-avatar-previews">
          <div className="gif-avatar-preview">
            <img src={gifDataUrl} alt="" className="gif-avatar-preview-img" />
            <span className="gif-avatar-preview-label">Анимация</span>
          </div>
          <div className="gif-avatar-preview">
            {preview ? (
              <img src={preview} alt="" className="gif-avatar-preview-img" />
            ) : (
              <div className="gif-avatar-preview-img gif-avatar-preview-empty">
                <Loader2 size={18} className="spin" />
              </div>
            )}
            <span className="gif-avatar-preview-label">Статичный кадр</span>
          </div>
        </div>

        {frames !== null && (
          <div className="gif-avatar-frame-row">
            <label className="gif-avatar-frame-label">
              Кадр {Math.min(frame, frames - 1) + 1} из {frames}
            </label>
            <input
              type="range"
              min={0}
              max={Math.max(0, frames - 1)}
              value={Math.min(frame, frames - 1)}
              disabled={!seekable}
              onChange={(e) => setFrame(Number(e.target.value))}
            />
            {!seekable && (
              <span className="gif-avatar-hint">
                Этот браузер не умеет доставать произвольный кадр гифки — будет
                использован первый.
              </span>
            )}
          </div>
        )}

        <label className="gif-avatar-toggle">
          <input
            type="checkbox"
            checked={downloadable}
            onChange={(e) => setDownloadable(e.target.checked)}
          />
          <span>
            <Download size={13} /> Разрешить другим скачивать мой аватар
          </span>
        </label>

        <p className="gif-avatar-hint">
          Обычно виден статичный кадр. Анимация играет, когда вы говорите в
          голосовом канале, когда на ваше сообщение навели курсор и в карточке
          профиля.
        </p>

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={handleSave} disabled={saving || !preview}>
          {saving ? <Loader2 size={15} className="spin" /> : 'Готово'}
        </button>
        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}
