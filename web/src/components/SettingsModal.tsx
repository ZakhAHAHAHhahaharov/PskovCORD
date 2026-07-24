import { LogOut, Volume2, Mic, AudioWaveform, X } from 'lucide-react'
import { useSettings, DEFAULT_SETTINGS } from '../settings'

// min(0.005) + max(0.15) шкалы чувствительности — см. onChange/value ниже.
const THRESHOLD_RANGE_SUM = 0.155

function SliderField({
  icon,
  label,
  value,
  displayValue,
  min,
  max,
  step,
  onChange,
  onReset,
}: {
  icon: React.ReactNode
  label: string
  value: number
  displayValue: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onReset: () => void
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">
          {icon} {label}
        </span>
        <span className="settings-field-value">{displayValue}</span>
      </div>
      <div className="settings-field-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button className="settings-field-reset" title="Сбросить по умолчанию" onClick={onReset}>
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

export default function SettingsModal({
  onClose,
  onLogout,
}: {
  onClose: () => void
  onLogout: () => void
}) {
  const {
    outputVolume,
    setOutputVolume,
    micGain,
    setMicGain,
    micThreshold,
    setMicThreshold,
  } = useSettings()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Настройки</h2>

        <SliderField
          icon={<Volume2 size={15} />}
          label="Громкость собеседников"
          value={outputVolume}
          displayValue={`${Math.round(outputVolume * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          onChange={setOutputVolume}
          onReset={() => setOutputVolume(DEFAULT_SETTINGS.outputVolume)}
        />

        <SliderField
          icon={<Mic size={15} />}
          label="Громкость своего микрофона"
          value={micGain}
          displayValue={`${Math.round(micGain * 100)}%`}
          min={0}
          max={2}
          step={0.01}
          onChange={setMicGain}
          onReset={() => setMicGain(DEFAULT_SETTINGS.micGain)}
        />

        <SliderField
          icon={<AudioWaveform size={15} />}
          label="Чувствительность микрофона"
          // Ползунок показывает "чувствительность" (правее — чувствительнее),
          // а порог RMS устроен наоборот (меньше порог — чувствительнее) —
          // разворачиваем шкалу в обе стороны (чтение и запись), чтобы
          // контрол вёл себя интуитивно: THRESHOLD_RANGE_SUM - x самообратна.
          value={THRESHOLD_RANGE_SUM - micThreshold}
          displayValue={
            micThreshold <= 0.01 ? 'Максимальная' : micThreshold >= 0.14 ? 'Минимальная' : 'Средняя'
          }
          min={0.005}
          max={0.15}
          step={0.005}
          onChange={(v) => setMicThreshold(THRESHOLD_RANGE_SUM - v)}
          onReset={() => setMicThreshold(DEFAULT_SETTINGS.micThreshold)}
        />
        <p className="settings-hint">
          Насколько громко нужно говорить, чтобы у остальных загорелось кольцо "говорит".
        </p>

        <button className="settings-logout" onClick={onLogout}>
          <LogOut size={15} /> Выйти из аккаунта
        </button>

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
