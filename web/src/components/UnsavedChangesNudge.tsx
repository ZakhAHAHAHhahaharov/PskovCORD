import { Loader2 } from 'lucide-react'

/**
 * Плашка "Изменения не сохранены" — всплывает под модалом, когда попытались
 * закрыть его кликом мимо, а черновик ещё не сохранён (см.
 * useUnsavedChangesGuard). "Сброс" отменяет черновик и закрывает модал,
 * "Сохранить" — коммитит его тем же путём, что и обычная кнопка сохранения
 * внутри модала.
 */
export default function UnsavedChangesNudge({
  onSave,
  onDiscard,
  saving,
}: {
  onSave: () => void
  onDiscard: () => void
  saving?: boolean
}) {
  return (
    <div className="unsaved-changes-nudge" onClick={(e) => e.stopPropagation()}>
      <span className="unsaved-changes-nudge-text">Изменения не сохранены</span>
      <div className="unsaved-changes-nudge-actions">
        <button type="button" className="btn-secondary" onClick={onDiscard} disabled={saving}>
          Сброс
        </button>
        <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}
