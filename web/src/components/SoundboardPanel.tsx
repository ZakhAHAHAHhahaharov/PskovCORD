import { useState } from 'react'
import { Loader2, Music, Plus, Trash2, X } from 'lucide-react'
import { api, uploadSound } from '../api'
import { useGateway } from '../gateway'
import { invalidateServerSounds, useServerSounds } from '../soundboard'
import { useEscToClose } from '../modalStack'

/** MAX_SOUND_BYTES на бэкенде. Дублируется здесь не ради валидации (она
 * всё равно на сервере), а чтобы не гнать по сети файл, который заведомо
 * отвергнут, и сказать об этом сразу. */
const MAX_SOUND_BYTES = 512 * 1024

/**
 * Соундборд звонка: сетка кнопок со звуками сервера.
 *
 * Звук играет у ВСЕХ, кто сейчас в этом же голосовом канале, но
 * проигрывает его каждый у себя (см. web/src/soundboard.ts) — поэтому
 * громкость у каждого своя, а отключивший звук соундборд не услышит.
 */
export default function SoundboardPanel({
  serverId,
  canManage,
  onClose,
}: {
  /** Сервер, чьи звуки показываем. null — звонок в личке/группе: своих
   * звуков там нет, и панель не открыть (см. VoiceStage). */
  serverId: number | null
  /** Право create_expressions — показывать ли кнопку загрузки. */
  canManage: boolean
  onClose: () => void
}) {
  const gateway = useGateway()
  const sounds = useServerSounds(serverId)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  useEscToClose(onClose)

  const handleFile = async (file: File | undefined) => {
    if (!file || serverId == null) return
    setError('')
    if (file.size > MAX_SOUND_BYTES) {
      setError(
        `Файл больше ${Math.round(MAX_SOUND_BYTES / 1024)} КБ. ` +
          'Соундборд — это короткие звуки на пару секунд.',
      )
      return
    }
    // Имя по умолчанию — из имени файла без расширения: спрашивать его
    // отдельной формой ради звука, который заливают пачкой, слишком дорого.
    // Переименовать можно потом (api.renameSound).
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 32) || 'Звук'
    setUploading(true)
    try {
      await uploadSound(serverId, name, file, '')
      // Событие server_sounds обновит набор само, но если оно почему-то не
      // дойдёт, панель осталась бы пустой на глазах у того, кто только что
      // залил файл.
      invalidateServerSounds(serverId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const remove = async (soundId: number) => {
    if (serverId == null) return
    try {
      await api.deleteSound(serverId, soundId)
      invalidateServerSounds(serverId)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="soundboard-panel">
      <div className="soundboard-head">
        <Music size={14} />
        <span className="soundboard-title">Соундборд</span>
        <button type="button" className="soundboard-close" title="Закрыть" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {error && <div className="soundboard-error">{error}</div>}

      <div className="soundboard-grid">
        {sounds.map((sound) => (
          <div className="soundboard-item" key={sound.id}>
            <button
              type="button"
              className="soundboard-btn"
              title={sound.name}
              onClick={() => gateway.soundboardPlay(sound.id)}
            >
              <span className="soundboard-btn-emoji">{sound.emoji || '🔊'}</span>
              <span className="soundboard-btn-name">{sound.name}</span>
            </button>
            {canManage && (
              <button
                type="button"
                className="soundboard-remove"
                title="Удалить звук"
                onClick={() => void remove(sound.id)}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}

        {canManage && (
          <label className="soundboard-add">
            {uploading ? <Loader2 size={18} className="spin" /> : <Plus size={18} />}
            <span>{uploading ? 'Загрузка…' : 'Добавить'}</span>
            <input
              type="file"
              accept="audio/*"
              hidden
              disabled={uploading}
              onChange={(e) => {
                void handleFile(e.target.files?.[0])
                // Сбрасываем значение: иначе повторный выбор ТОГО ЖЕ файла
                // (после неудачи) не вызвал бы change вовсе.
                e.target.value = ''
              }}
            />
          </label>
        )}
      </div>

      {sounds.length === 0 && !canManage && (
        <div className="soundboard-empty">
          На этом сервере пока нет звуков.
        </div>
      )}
    </div>
  )
}
