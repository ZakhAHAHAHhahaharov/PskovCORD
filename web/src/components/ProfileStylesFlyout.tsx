import { useEffect, useRef } from 'react'
import { Lock, Palette } from 'lucide-react'
import { useEscToClose } from '../modalStack'

// Пока ничего не грузится с бэка — просто заглушки-квадраты, по клику
// "Пока не реализовано" (тот же паттерн, что и у .profile-card-badge). Когда
// появится настоящий каталог декораций/эффектов — это станет списком с
// сервера, а не константой.
const PLACEHOLDER_COUNT = 5

function PlaceholderRow() {
  return (
    <div className="styles-flyout-placeholder-row">
      {Array.from({ length: PLACEHOLDER_COUNT }).map((_, i) => (
        <button
          key={i}
          type="button"
          className="styles-flyout-placeholder-card"
          title="Пока не реализовано"
          onClick={() => alert('Пока не реализовано')}
        >
          <Lock size={16} />
        </button>
      ))}
    </div>
  )
}

/**
 * Флайаут "Стили" — открывается закладкой-кисточкой у аватарки в
 * ProfileModal (см. ProfileCardHeader.profile-styles-tab), растёт от правого
 * края модалки (см. .styles-flyout в index.css, позиционируется от
 * .profile-modal — см. комментарий там).
 *
 * Клик мимо закрывает его САМОГО, не задевая ProfileModal под ним — тот же
 * приём, что в MiniProfilePopup (document-level mousedown с проверкой
 * ref.contains, а не собственный .modal-overlay: флайаут не должен гасить
 * весь экран, это лёгкая панелька, а не полноценный модал). ProfileModal'у
 * тут не нужен guard на несохранённые изменения (см. useUnsavedChangesGuard) —
 * внутри либо мгновенный автосейв (цвет баннера), либо переход в отдельный
 * DisplayNameStyleModal со своим черновиком и своим guard'ом.
 */
export default function ProfileStylesFlyout({
  bannerColor,
  onSetBannerColor,
  onOpenNameStyle,
  onClose,
}: {
  bannerColor: string
  onSetBannerColor: (v: string) => void
  onOpenNameStyle: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscToClose(onClose)

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  return (
    <div ref={ref} className="styles-flyout">
      <h3 className="styles-flyout-title">
        <Palette size={15} /> Стили
      </h3>

      <div className="styles-flyout-section">
        <div className="styles-flyout-section-title">Украшения аватара</div>
        <PlaceholderRow />
      </div>

      <div className="styles-flyout-section">
        <div className="styles-flyout-section-title">Цвет баннера</div>
        <label className="styles-flyout-color-row">
          <input
            type="color"
            value={bannerColor || '#000000'}
            onChange={(e) => onSetBannerColor(e.target.value)}
          />
          <span className="styles-hint">Виден сквозь прозрачные пиксели гифки-баннера.</span>
        </label>
        {bannerColor && (
          <button
            type="button"
            className="styles-flyout-reset-link"
            onClick={() => onSetBannerColor('')}
          >
            Сбросить цвет
          </button>
        )}
      </div>

      <div className="styles-flyout-section">
        <div className="styles-flyout-section-title">Эффект профиля и рамка</div>
        <PlaceholderRow />
      </div>

      <button type="button" className="styles-flyout-name-style-btn" onClick={onOpenNameStyle}>
        Стиль отображаемого имени
      </button>

      <button className="modal-close" onClick={onClose}>
        Закрыть
      </button>
    </div>
  )
}
