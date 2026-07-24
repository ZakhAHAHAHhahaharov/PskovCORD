import { useEffect, useRef } from 'react'
import { LogOut, Volume2, Mic, AudioWaveform, X } from 'lucide-react'
import { useSettings, DEFAULT_SETTINGS } from '../settings'
import { useVoice } from '../voice'

// min(0.005) + max(0.15) шкалы чувствительности — см. onChange/value ниже.
const THRESHOLD_RANGE_SUM = 0.155
// RMS, соответствующий 100% ширины метра — обычная громкая речь в микрофон
// редко превышает это значение, порог/gain живут в куда меньшем диапазоне.
const METER_SCALE = 0.3

/** Живой уровень своего микрофона — полоса + метка порога. Обновляется через
 * requestAnimationFrame напрямую в DOM (минуя React state), чтобы 60 кадров/с
 * не гоняли ре-рендер всего модала. Вне голосового канала микрофон не
 * захвачен — getMicLevel() тогда всегда 0, полоса просто остаётся пустой. */
function MicLevelMeter({ thresholdPct }: { thresholdPct: number }) {
  const { getMicLevel } = useVoice()
  const fillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let rafId: number
    const tick = () => {
      const pct = Math.min(100, (getMicLevel() / METER_SCALE) * 100)
      if (fillRef.current) fillRef.current.style.width = `${pct}%`
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [getMicLevel])

  return (
    <div className="mic-level-meter">
      <div className="mic-level-meter-fill" ref={fillRef} />
      <div className="mic-level-meter-threshold" style={{ left: `${thresholdPct}%` }} />
    </div>
  )
}

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
        <MicLevelMeter thresholdPct={Math.min(100, (micThreshold / METER_SCALE) * 100)} />
        <p className="settings-hint">
          Полоса — живой уровень вашего микрофона (только в голосовом канале), метка — порог
          срабатывания. Насколько громко нужно говорить, чтобы у остальных загорелось кольцо
          "говорит".
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
