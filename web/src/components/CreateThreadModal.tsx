import { FormEvent, useState } from 'react'
import { Loader2, Lock, MessagesSquare } from 'lucide-react'
import { useEscToClose } from '../modalStack'
import ToggleSwitch from './ToggleSwitch'

/**
 * Создание ветки — та же форма, что и CreateChannelModal, но короче: у ветки
 * нет ни приватности (она наследует доступ родительского канала, см. backend
 * chat.permissions.can_see_channel), ни выбора вида. Спрашивается только
 * название.
 *
 * Ветка «из сообщения» приходит сюда с предложенным названием — началом того
 * самого сообщения (см. useServerData.createThreadTarget). Оно уже лежит в
 * поле и выделено: чаще всего его оставляют как есть, но переписать можно, не
 * стирая вручную.
 */
export default function CreateThreadModal({
  channelName,
  suggestedName,
  onCreate,
  onClose,
}: {
  /** Родительский канал — в заголовке, чтобы было видно, где заводим ветку. */
  channelName: string
  /** Начало исходного сообщения; пусто — ветку заводят кнопкой в канале. */
  suggestedName?: string
  /** Возвращает промис: пока идёт запрос, кнопка заблокирована, а ошибка
   * показывается не закрывая модалку — набранное название не пропадает
   * (тот же приём, что и в CreateChannelModal). */
  onCreate: (name: string, inviteOnly: boolean) => Promise<void>
  onClose: () => void
}) {
  useEscToClose(onClose)
  const [name, setName] = useState(suggestedName ?? '')
  const [inviteOnly, setInviteOnly] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const trimmed = name.trim()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || saving) return
    setSaving(true)
    setError('')
    try {
      await onCreate(trimmed, inviteOnly)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Создать ветку в #{channelName}</h2>

        <form onSubmit={handleSubmit}>
          <div className="field-label">Название ветки</div>
          <div className="create-channel-name">
            <span className="create-channel-name-icon">
              <MessagesSquare size={15} />
            </span>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="о чём говорим"
              maxLength={100}
              autoFocus
              // Предложенное название выделяется целиком: набрать своё можно
              // сразу, не стирая подставленное.
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <div className="create-channel-option">
            <div className="create-channel-option-head">
              <span className="create-channel-option-label">
                <Lock size={15} /> Приватная ветка
              </span>
              <ToggleSwitch
                checked={inviteOnly}
                onChange={setInviteOnly}
                ariaLabel="Приватная ветка"
              />
            </div>
            <div className="create-channel-option-hint">
              {inviteOnly
                ? 'Ветку увидят только те, кого в неё добавят, и те, кто управляет каналами. Добавить людей можно потом — в меню ветки.'
                : 'Ветку увидят все, кому виден сам канал.'}
            </div>
          </div>

          <div className="create-channel-option-hint">
            Когда обсуждение закончится, ветку можно закрыть: она уйдёт из
            списка каналов, но сообщения останутся.
          </div>

          {error && <div className="login-error">{error}</div>}

          <div className="create-channel-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={!trimmed || saving}>
              {saving ? <Loader2 size={15} className="spin" /> : 'Создать ветку'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
