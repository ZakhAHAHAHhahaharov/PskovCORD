import { useRef, useState } from 'react'
import { Loader2, Play, Trash2, Upload } from 'lucide-react'
import { api, VoiceSoundKind, uploadVoiceSound } from '../api'
import { useAuth } from '../auth'
import {
  JOIN_SOUND_OPTIONS, JoinSoundKey, playJoinSoundFor, playLeaveSoundFor,
} from '../joinSound'

/** MAX_JOIN_SOUND_BYTES на бэкенде. Дублируется здесь не ради валидации (она
 * всё равно на сервере), а чтобы не гнать по сети заведомо отвергнутый файл и
 * сказать об этом сразу. */
const MAX_BYTES = 512 * 1024

/**
 * Выбор личного звука входа в голосовой канал ИЛИ выхода из него.
 *
 * Один компонент на оба: механика у них одна и та же, различаются подписи и
 * пара имён полей. Два почти одинаковых компонента расходились бы при первой
 * же правке — а правки тут будут, это настройка, которую видно.
 *
 * Ключевое, что должен понимать читающий: звук слышат ОСТАЛЬНЫЕ, а не он
 * сам. Поэтому подпись говорит об этом прямо — иначе настройка читается как
 * «что я слышу, когда заходят другие», а это ровно наоборот.
 *
 * Хранится на аккаунте, а не в локальных настройках устройства (в отличие от
 * громкости и темы): звук должен звучать одинаково у всех слушателей и не
 * зависеть от того, с какого браузера человек зашёл.
 */
export default function JoinSoundFields({ kind }: { kind: VoiceSoundKind }) {
  const { user, updateLocalUser } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  const isJoin = kind === 'join'
  const current = (isJoin ? user.join_sound : user.leave_sound) as JoinSoundKey
  // «Есть ли загруженный файл» — отдельно от «что играть остальным»
  // (join_sound_url пуст при готовом варианте). Без этого поля плитка «Свой
  // звук» стала бы недоступной, стоит переключиться на готовый, и вернуться
  // к своему файлу было бы уже нельзя.
  const customUrl = isJoin ? user.custom_join_sound_url : user.custom_leave_sound_url
  const preview = isJoin ? playJoinSoundFor : playLeaveSoundFor
  const title = isJoin
    ? 'Звук моего входа в голосовой канал'
    : 'Звук моего выхода из голосового канала'
  const hint = isJoin
    ? 'Его слышат те, кто уже сидит в канале, когда вы заходите.'
    : 'Его слышат те, кто остаётся в канале, когда вы уходите.' 

  const choose = async (key: JoinSoundKey) => {
    setError('')
    // Предпрослушивание — сразу, ещё до ответа сервера: выбор звука это
    // прежде всего «послушать, как он звучит», и ждать ради этого сеть незачем.
    preview(key, customUrl)
    if (key === current) return
    setBusy(true)
    try {
      updateLocalUser(await api.setVoiceSound(kind, key))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError('')
    if (file.size > MAX_BYTES) {
      setError(
        `Файл больше ${Math.round(MAX_BYTES / 1024)} КБ. Это короткий сигнал ` +
          'на пару секунд, а не музыка.',
      )
      return
    }
    setBusy(true)
    try {
      updateLocalUser(await uploadVoiceSound(kind, file))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeCustom = async () => {
    setError('')
    setBusy(true)
    try {
      updateLocalUser(await api.clearVoiceSound(kind))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-field-header">
        <span className="settings-field-label">{title}</span>
      </div>
      <div className="settings-hint">
        {hint} Себе вы его не услышите — только при выборе здесь.
      </div>

      <div className="join-sound-options">
        {JOIN_SOUND_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`join-sound-option ${current === option.key ? 'active' : ''}`}
            disabled={busy}
            onClick={() => void choose(option.key)}
          >
            <span className="join-sound-option-label">
              {option.key !== 'none' && <Play size={11} />}
              {option.label}
            </span>
            <span className="join-sound-option-hint">{option.hint}</span>
          </button>
        ))}

        {/* Свой файл — такая же плитка в общем ряду, а не отдельная секция:
            для человека это ещё один вариант выбора, а не другая функция. */}
        <button
          type="button"
          className={`join-sound-option ${current === 'custom' ? 'active' : ''}`}
          disabled={busy || !customUrl}
          onClick={() => void choose('custom')}
          title={customUrl ? undefined : 'Сначала загрузите файл'}
        >
          <span className="join-sound-option-label">
            <Play size={11} /> Свой звук
          </span>
          <span className="join-sound-option-hint">
            {customUrl ? 'Загружен' : 'Не загружен'}
          </span>
        </button>
      </div>

      <div className="join-sound-actions">
        <button
          type="button"
          className="settings-permission-btn"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {customUrl ? 'Заменить файл' : 'Загрузить свой'}
        </button>
        {customUrl && (
          <button
            type="button"
            className="join-sound-remove"
            disabled={busy}
            onClick={() => void removeCustom()}
          >
            <Trash2 size={14} /> Убрать
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0])
            // Сбрасываем значение: иначе повторный выбор ТОГО ЖЕ файла
            // (после неудачи) не вызвал бы change вовсе.
            e.target.value = ''
          }}
        />
      </div>

      {error && <div className="login-error">{error}</div>}
    </div>
  )
}
