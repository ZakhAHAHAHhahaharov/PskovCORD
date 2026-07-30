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
 * ProfileModal (та же кнопка превращается в крестик, пока флайаут открыт —
 * см. ProfileModal.tsx). На десктопе — отдельная панель СЛЕВА от .modal
 * (position:absolute от .profile-modal-wrap, см. index.css), не двигающая
 * саму модалку; на мобильном — подменяет собой содержимое ТОЙ ЖЕ .modal
 * целиком (там панели рядом физически не умещаются). Своей кнопки закрытия
 * внутри нет — закрывает тот же крестик-закладка снаружи (или Esc/клик по
 * тёмному фону, гасящий редактор профиля целиком). Свой stopPropagation
 * ниже — чтобы клик ВНУТРИ флайаута не долетал до onClick={handleClose} на
 * .modal-overlay.
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
  useEscToClose(onClose)

  return (
    <div className="styles-flyout" onClick={(e) => e.stopPropagation()}>
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
    </div>
  )
}
