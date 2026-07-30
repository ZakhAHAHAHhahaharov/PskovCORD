import { useRef, useState, ChangeEvent } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard'
import {
  BANNER_MAX_H, BANNER_MAX_W, GRADIENT_PRESETS, SOURCE_IMAGE_MAX_BYTES,
  buildGradient, fileToBannerDataUrl, parseGradient,
} from '../images'
import UnsavedChangesNudge from './UnsavedChangesNudge'

/**
 * Редактор фона карточки профиля (градиент/фото/гифка) — раньше жил инлайн в
 * ProfileModal.tsx, теперь отдельная модалка: открывается по "Изменить" из
 * ImageHoverMenu над баннером. Своей кнопки "Сохранить" в привычном смысле
 * нет — единственная кнопка "Готово" сохраняет текущий выбор и закрывает
 * модалку разом (тот же принцип, что и у остальной карточки — "закрыл
 * значит сохранил", просто здесь это несколько взаимосвязанных полей
 * (градиент/цвета/угол/гифка), а не один инлайн-текст, поэтому коммит по
 * blur отдельного поля не подошёл бы).
 */
export default function BannerEditorModal({
  currentGradient,
  currentImage,
  onSave,
  onClose,
}: {
  currentGradient: string
  currentImage: string
  onSave: (gradient: string, image: string) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  const initialGradient = parseGradient(currentGradient)
  const initialMode: 'gradient' | 'gif' = currentImage ? 'gif' : 'gradient'
  const [mode, setMode] = useState<'gradient' | 'gif'>(initialMode)
  const [gradientFrom, setGradientFrom] = useState(initialGradient.from)
  const [gradientTo, setGradientTo] = useState(initialGradient.to)
  const [gradientAngle, setGradientAngle] = useState(initialGradient.angle)
  const [image, setImage] = useState(currentImage)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const isDirty =
    mode !== initialMode ||
    gradientFrom !== initialGradient.from ||
    gradientTo !== initialGradient.to ||
    gradientAngle !== initialGradient.angle ||
    image !== currentImage
  const { modalRef, showNudge, handleOverlayClick } = useUnsavedChangesGuard(isDirty, onClose)
  const handleDiscard = () => {
    setMode(initialMode)
    setGradientFrom(initialGradient.from)
    setGradientTo(initialGradient.to)
    setGradientAngle(initialGradient.angle)
    setImage(currentImage)
    onClose()
  }

  const currentGradientCss = buildGradient(gradientAngle, gradientFrom, gradientTo)

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    try {
      setImage(await fileToBannerDataUrl(file))
      setMode('gif')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleDone = async () => {
    setSaving(true)
    setError('')
    try {
      const desiredGradient = mode === 'gradient' ? currentGradientCss : ''
      const desiredImage = mode === 'gif' ? image : ''
      await onSave(desiredGradient, desiredImage)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="unsaved-guard-stack">
      <div className="modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Фон карточки профиля</h2>

        <div
          className="banner-preview"
          style={{ background: mode === 'gif' && image ? undefined : currentGradientCss }}
        >
          {mode === 'gif' && image && (
            <img src={image} alt="" className="banner-preview-img" />
          )}
        </div>

        <div className="banner-mode-tabs">
          <button
            type="button"
            className={`banner-mode-tab ${mode === 'gradient' ? 'active' : ''}`}
            onClick={() => setMode('gradient')}
          >
            Градиент
          </button>
          <button
            type="button"
            className={`banner-mode-tab ${mode === 'gif' ? 'active' : ''}`}
            onClick={() => setMode('gif')}
          >
            Фото / гифка
          </button>
        </div>

        {mode === 'gradient' ? (
          <>
            <div className="gradient-presets">
              {GRADIENT_PRESETS.map(([from, to]) => (
                <button
                  key={from + to}
                  type="button"
                  className="gradient-preset"
                  style={{ background: buildGradient(gradientAngle, from, to) }}
                  title="Применить пресет"
                  onClick={() => {
                    setGradientFrom(from)
                    setGradientTo(to)
                  }}
                />
              ))}
            </div>
            <div className="gradient-controls">
              <label className="gradient-color-field">
                От
                <input
                  type="color"
                  value={gradientFrom}
                  onChange={(e) => setGradientFrom(e.target.value)}
                />
              </label>
              <label className="gradient-color-field">
                До
                <input
                  type="color"
                  value={gradientTo}
                  onChange={(e) => setGradientTo(e.target.value)}
                />
              </label>
              <label className="gradient-angle-field">
                Угол
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={gradientAngle}
                  onChange={(e) => setGradientAngle(Number(e.target.value))}
                />
              </label>
            </div>
          </>
        ) : (
          <div className="banner-gif-row">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => bannerFileRef.current?.click()}
            >
              {image ? 'Заменить фото или гифку' : 'Загрузить фото или гифку'}
            </button>
            <input
              ref={bannerFileRef}
              type="file"
              accept="image/gif,image/webp,image/png,image/jpeg"
              className="profile-file-input"
              onChange={handleFileChange}
            />
            {image && (
              <button
                type="button"
                className="profile-avatar-remove"
                onClick={() => setImage('')}
              >
                <Trash2 size={13} /> Убрать
              </button>
            )}
            <span className="banner-hint">
              Фото и большая гифка обрежутся и сожмутся до {BANNER_MAX_W}×{BANNER_MAX_H}; гифка
              подходящего размера останется анимированной. Макс. исходный файл —{' '}
              {Math.round(SOURCE_IMAGE_MAX_BYTES / 1_000_000)} МБ.
            </span>
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" onClick={handleDone} disabled={saving}>
          {saving ? <Loader2 size={15} className="spin" /> : 'Готово'}
        </button>
        <button className="modal-close" onClick={onClose}>
          Отмена
        </button>
      </div>

      {showNudge && (
        <UnsavedChangesNudge onSave={handleDone} onDiscard={handleDiscard} saving={saving} />
      )}
      </div>
    </div>
  )
}
