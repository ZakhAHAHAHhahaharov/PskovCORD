import lancerSplatUrl from './assets/sounds/lancer-splat.ogg'
import reverseLancerSplatUrl from './assets/sounds/reverse-lancer-splat.ogg'
import boWompUrl from './assets/sounds/bo-womp.ogg'
import boWompReverseUrl from './assets/sounds/bo-womp_reverse_.ogg'

/**
 * Звуки голосового канала. Вход/выход и старт/стоп демонстрации — реальные
 * аудиофайлы (импортом, а не из public/, чтобы Vite переписал URL под
 * base:'./' — иначе в Electron/file:// абсолютный путь "/sounds/..." был бы
 * битым). Остальное — короткие синтезированные тона, чистый Web Audio API.
 */
export function playFile(url: string, volume = 0.7) {
  try {
    const audio = new Audio(url)
    audio.volume = volume
    void audio.play().catch(() => {})
  } catch {
    // ignore
  }
}

let audioCtx: AudioContext | null = null

function ctx(): AudioContext | null {
  const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext
  if (!AudioCtx) return null
  if (!audioCtx) audioCtx = new AudioCtx()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

function beep(freq: number, durationMs: number, startDelayMs = 0, gain = 0.15) {
  const ac = ctx()
  if (!ac) return
  const osc = ac.createOscillator()
  const gainNode = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  osc.connect(gainNode)
  gainNode.connect(ac.destination)

  const start = ac.currentTime + startDelayMs / 1000
  const dur = durationMs / 1000
  gainNode.gain.setValueAtTime(0, start)
  gainNode.gain.linearRampToValueAtTime(gain, start + 0.008)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/** Собрать сигнал из нот. Вынесено отдельно ради готовых вариантов личного
 * звука входа (см. joinSound.ts): там их пять, и городить под каждый свою
 * функцию с парой beep'ов значило бы пять почти одинаковых функций. */
export function toneSequence(
  notes: { freq: number; ms: number; delay?: number; gain?: number }[],
) {
  for (const note of notes) beep(note.freq, note.ms, note.delay ?? 0, note.gain ?? 0.15)
}

/** Кто-то вошёл в голосовой канал, где мы уже находимся — СТАНДАРТНЫЙ звук.
 * Личный звук конкретного человека проигрывает playJoinSoundFor (joinSound.ts),
 * который на этот и откатывается, если у человека выбран обычный вариант. */
export function playJoinSound() {
  playFile(boWompUrl)
}

/** Кто-то вышел из голосового канала, где мы всё ещё находимся. */
export function playLeaveSound() {
  playFile(boWompReverseUrl)
}

/** Кто-то (не мы) начал демонстрацию экрана в канале, где мы находимся. */
export function playScreenShareStartSound() {
  playFile(lancerSplatUrl)
}

/** Кто-то (не мы) закончил демонстрацию экрана. */
export function playScreenShareStopSound() {
  playFile(reverseLancerSplatUrl)
}

/** Клик по своей кнопке мьюта/дефена. `turningOn` — включаем ли обратно. */
export function playToggleSound(turningOn: boolean) {
  beep(turningOn ? 620 : 400, 60, 0, 0.12)
}

/** Связь с голосовым каналом неожиданно оборвалась — идёт автопереподключение. */
export function playDisconnectSound() {
  beep(500, 70, 0, 0.18)
  beep(350, 70, 90, 0.18)
  beep(220, 140, 180, 0.18)
}

/** Связь восстановлена сама после обрыва. */
export function playReconnectedSound() {
  beep(440, 80, 0, 0.16)
  beep(660, 120, 80, 0.16)
}

let ringInterval: ReturnType<typeof setInterval> | null = null

/** Входящий звонок в личке/группе — короткая двухтоновая трель по кругу,
 * пока баннер открыт (см. IncomingCallBanner). Синтетический тон, как и
 * остальные короткие сигналы в этом файле — не нужен отдельный аудиофайл. */
export function playIncomingCallRing() {
  if (ringInterval) return
  const ring = () => {
    beep(880, 220, 0, 0.16)
    beep(660, 220, 260, 0.16)
  }
  ring()
  ringInterval = setInterval(ring, 1600)
}

export function stopIncomingCallRing() {
  if (ringInterval) {
    clearInterval(ringInterval)
    ringInterval = null
  }
}

/** Кто-то в этом же голосовом канале попросил нас включить демонстрацию
 * экрана — короткая одноразовая трель (в отличие от playIncomingCallRing не
 * зацикливается — это не входящий звонок, а разовая просьба). */
export function playScreenShareRequestSound() {
  beep(740, 140, 0, 0.18)
  beep(920, 160, 150, 0.18)
}

/** Новое сообщение, пока вкладка не на виду (см. notifications.ts).
 *
 * Нарочно тише и короче всего остального в этом файле: звук голосового
 * канала слышат, когда сидят в нём, а этот — когда занимаются чем-то другим,
 * и перебивать он не должен. Две ноты вверх — «пришло», а не «случилось». */
export function playNotificationSound() {
  beep(880, 90, 0, 0.08)
  beep(1175, 120, 90, 0.08)
}

/** «Разбудить мальчика» — нас разбудили (см. ParticipantContextMenu), пока у
 * нас выключен микрофон или звук. Нарочно противный, длинный, дребезжащий
 * сигнал (в отличие от короткой вежливой трели выше) — цель именно
 * раздражать, а не тихо уведомить. */
export function playWakeUpSound() {
  for (let i = 0; i < 6; i++) {
    beep(1046, 130, i * 220, 0.3)
    beep(784, 130, i * 220 + 110, 0.3)
  }
}
