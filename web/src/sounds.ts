/**
 * Короткие синтезированные звуки для голосового канала — без внешних
 * аудиофайлов, чистый Web Audio API (пара тонов с экспоненциальным затуханием).
 */
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

/** Кто-то вошёл в голосовой канал, где мы уже находимся. */
export function playJoinSound() {
  beep(660, 90)
  beep(880, 100, 90)
}

/** Кто-то вышел из голосового канала, где мы всё ещё находимся. */
export function playLeaveSound() {
  beep(600, 90)
  beep(420, 110, 90)
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
