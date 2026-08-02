/**
 * Переключатель-пилюля (не обычный checkbox) — тот же вид, что и в настройках
 * конфиденциальности сервера, откуда он и переехал сюда, когда понадобился
 * второй раз (см. CreateChannelModal). Стили — .privacy-switch в index.css.
 */
export default function ToggleSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** Подпись для скринридера там, где рядом нет своего <label>. */
  ariaLabel?: string
}) {
  return (
    <label className={`privacy-switch ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="privacy-switch-track" />
    </label>
  )
}
