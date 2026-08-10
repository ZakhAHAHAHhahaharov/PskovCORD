/** Соундборд: набор звуков сервера и их проигрывание.
 *
 * Звук НЕ подмешивается в аудиопоток SFU (см. backend chat/models.py —
 * SoundboardSound): сервер рассылает событие, а файл каждый клиент играет у
 * себя. Отсюда два следствия, которых не было бы у серверного микширования:
 * громкость у каждого своя, а тот, кто отключил звук (deafen), соундборд не
 * услышит вовсе — и это правильно.
 */
import { useEffect, useState } from 'react'
import { api, SoundboardSound, mediaUrl } from './api'

/** Одновременно звучащих звуков — не больше этого.
 *
 * Соундборд это кнопка, по которой любят долбить: без потолка десять нажатий
 * подряд наложились бы друг на друга в кашу и остались бы висеть в памяти
 * десятком <audio>. */
const MAX_CONCURRENT = 4

const playing = new Set<HTMLAudioElement>()

/** Проиграть звук по ссылке. volume 0..1 — уже с учётом настроек слушателя. */
export function playSoundboardSound(url: string, volume: number) {
  if (!url || volume <= 0) return
  if (playing.size >= MAX_CONCURRENT) {
    // Вытесняем самый старый, а не отказываемся играть новый: нажали-то
    // именно сейчас, и молчание в ответ выглядело бы поломкой.
    const oldest = playing.values().next().value
    if (oldest) {
      oldest.pause()
      playing.delete(oldest)
    }
  }
  try {
    const audio = new Audio(mediaUrl(url))
    audio.volume = Math.min(1, Math.max(0, volume))
    playing.add(audio)
    const done = () => playing.delete(audio)
    audio.addEventListener('ended', done)
    audio.addEventListener('error', done)
    void audio.play().catch(done)
  } catch {
    // Автовоспроизведение может быть запрещено, пока на странице не было ни
    // одного клика. Ронять из-за этого обработчик события нельзя.
  }
}

// --- набор звуков сервера ---------------------------------------------------
// Кэш с подпиской — тем же приёмом, что у эмодзи и стикеров: панель
// открывают из звонка, и ходить за списком на каждое её открытие незачем.
const cache = new Map<number, SoundboardSound[]>()
const listeners = new Map<number, Set<() => void>>()
const loading = new Set<number>()

function notify(serverId: number) {
  listeners.get(serverId)?.forEach((fn) => fn())
}

/** Заменить набор целиком — приходит из события server_sounds. */
export function setServerSounds(serverId: number, sounds: SoundboardSound[]) {
  cache.set(serverId, sounds)
  notify(serverId)
}

/** Звуки сервера. Первое обращение подгружает их с бэкенда. */
export function useServerSounds(serverId: number | null): SoundboardSound[] {
  const [sounds, setSounds] = useState<SoundboardSound[]>(() =>
    serverId != null ? cache.get(serverId) ?? [] : [],
  )

  useEffect(() => {
    if (serverId == null) {
      setSounds([])
      return
    }
    const update = () => setSounds(cache.get(serverId) ?? [])
    update()

    let set = listeners.get(serverId)
    if (!set) {
      set = new Set()
      listeners.set(serverId, set)
    }
    set.add(update)

    if (!cache.has(serverId) && !loading.has(serverId)) {
      loading.add(serverId)
      void api
        .serverSounds(serverId)
        .then((list) => setServerSounds(serverId, list))
        .catch(() => {
          // Не участник сервера или сеть — пустой набор, панель просто
          // скажет «звуков пока нет». Ретраить незачем: событие
          // server_sounds всё равно принесёт актуальный набор.
          setServerSounds(serverId, [])
        })
        .finally(() => loading.delete(serverId))
    }

    return () => {
      set!.delete(update)
      if (set!.size === 0) listeners.delete(serverId)
    }
  }, [serverId])

  return sounds
}

/** Сбросить кэш сервера — после загрузки/удаления, если событие не пришло. */
export function invalidateServerSounds(serverId: number) {
  cache.delete(serverId)
  notify(serverId)
}
