/** Личный звук входа в голосовой канал.
 *
 * Играет НЕ у владельца, а у всех, кто уже сидит в канале, когда владелец
 * заходит, — это «мелодия выхода на сцену», а не уведомление себе. Поэтому
 * выбор хранится на аккаунте (см. backend accounts.models.User.join_sound), а
 * не в локальных настройках устройства: он должен звучать одинаково у всех
 * слушателей и не зависеть от того, с какого браузера человек зашёл.
 *
 * Готовые варианты синтезируются здесь же через Web Audio — файлов для них не
 * нужно вовсе. Свой звук приезжает обычной ссылкой на /media.
 */
import { mediaUrl } from './api'
import { playFile, playJoinSound, toneSequence } from './sounds'

/** Ключи совпадают с JOIN_SOUND_PRESETS на бэкенде — там же валидация. */
export type JoinSoundKey = 'default' | 'none' | 'blip' | 'chime' | 'pop' | 'rise' | 'custom'

export const JOIN_SOUND_OPTIONS: { key: JoinSoundKey; label: string; hint: string }[] = [
  { key: 'default', label: 'Стандартный', hint: 'Как было всегда' },
  { key: 'blip', label: 'Короткий сигнал', hint: 'Одна нота, не отвлекает' },
  { key: 'chime', label: 'Колокольчик', hint: 'Три ноты вверх' },
  { key: 'pop', label: 'Хлопок', hint: 'Глухой и низкий' },
  { key: 'rise', label: 'Восходящий', hint: 'Заметнее остальных' },
  { key: 'none', label: 'Без звука', hint: 'Захожу тихо' },
]

/** Проиграть звук входа КОНКРЕТНОГО человека.
 *
 * url — его загруженный файл (пусто, если выбран готовый вариант). Пустой
 * url при key === 'custom' — законное состояние: человек выбрал «свой» и не
 * успел загрузить. Откатываемся на стандартный, потому что тишина вместо
 * звука выглядит как поломка, а не как выбор (для тишины есть 'none').
 */
export function playJoinSoundFor(key: JoinSoundKey | undefined, url: string | undefined) {
  switch (key) {
    case 'none':
      return
    case 'custom':
      if (url) {
        playFile(mediaUrl(url))
        return
      }
      playJoinSound()
      return
    case 'blip':
      toneSequence([{ freq: 880, ms: 90 }])
      return
    case 'chime':
      toneSequence([
        { freq: 660, ms: 90 },
        { freq: 880, ms: 90, delay: 90 },
        { freq: 1175, ms: 140, delay: 180 },
      ])
      return
    case 'pop':
      toneSequence([{ freq: 180, ms: 120, gain: 0.25 }])
      return
    case 'rise':
      toneSequence([
        { freq: 440, ms: 70 },
        { freq: 587, ms: 70, delay: 70 },
        { freq: 784, ms: 70, delay: 140 },
        { freq: 1046, ms: 160, delay: 210 },
      ])
      return
    default:
      // 'default' и всё неизвестное (например, вариант, добавленный на
      // сервере позже этой сборки клиента) — прежний звук.
      playJoinSound()
  }
}
