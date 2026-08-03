/**
 * Запись голосового сообщения с микрофона.
 *
 * Отдельный модуль, а не пара хуков в композере: здесь довольно много возни с
 * браузерными API (MediaRecorder, AudioContext, выбор кодека), и вся она не
 * имеет отношения к тому, как выглядит поле ввода.
 *
 * Дорожка (пики громкости) считается ЗДЕСЬ, у клиента, и уезжает на сервер
 * вместе с файлом. Не на бэкенде: декодера звука там нет и заводить его ради
 * шестидесяти чисел не стоит, а у браузера он встроенный (AudioContext).
 * Не в момент отрисовки сообщения: тогда каждый читатель качал бы и
 * декодировал весь файл только чтобы понять, какой рисунок нарисовать, — и
 * дорожка появлялась бы через секунду после самого сообщения.
 */

/** Сколько столбиков в дорожке — столько же, сколько принимает бэкенд (см.
 * chat/models.py MAX_WAVEFORM_POINTS). */
export const WAVEFORM_POINTS = 64

/** Потолок длительности, совпадает с backend MAX_VOICE_MS. Здесь — чтобы
 * остановить запись самим, а не упереться в отказ уже после неё. */
export const MAX_VOICE_MS = 10 * 60 * 1000

/** Кодеки в порядке предпочтения. Opus в webm — то, что умеют Chrome и Edge;
 * Firefox отдаёт ogg; Safari — mp4. Пустая строка в конце значит «пусть
 * браузер решит сам»: MediaRecorder без mimeType всегда пишет хоть чем-то, а
 * тип файла бэкенд всё равно определяет по сигнатуре (chat/uploads.py
 * sniff_voice), а не по нашему заявлению. */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  '',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const type of PREFERRED_TYPES) {
    if (!type || MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

/** Умеет ли этот браузер записывать звук вообще. Проверяется до показа кнопки
 * микрофона: кнопка, которая на нажатие отвечает ошибкой, хуже отсутствующей. */
export function canRecordVoice(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

/**
 * Идущая прямо сейчас запись.
 *
 * Начинается сразу в start(), заканчивается либо stop() (получить запись),
 * либо cancel() (выбросить). Дорожку считаем на живом потоке, а не по готовому
 * файлу: декодировать webm/opus из MediaRecorder через decodeAudioData
 * получается не во всех браузерах (Firefox спотыкается на потоковом webm без
 * длительности в заголовке), а анализатор во время записи работает везде
 * одинаково — и заодно даёт те же числа, что рисуются в индикаторе.
 */
export class VoiceRecording {
  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
    private readonly chunks: Blob[],
    private readonly peaks: number[],
    private readonly startedAt: number,
    private readonly cleanupAudio: () => void,
  ) {}

  static async start(onLevel?: (level: number) => void): Promise<VoiceRecording> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Те же обработки, что и в голосовом канале: без них запись с ноутбука
        // получается с эхом и фоном вентилятора.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    // Анализатор снимает громкость примерно 20 раз в секунду. Пики копятся
    // все, а сжимаются до WAVEFORM_POINTS уже в конце (см. resample): сколько
    // их будет, заранее неизвестно — длительность записи выбирает человек.
    const peaks: number[] = []
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
    const buffer = new Float32Array(analyser.fftSize)
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buffer)
      // RMS, а не максимум: максимум ловит одиночный щелчок и рисует
      // столбик в потолок там, где было тихо.
      let sum = 0
      for (const sample of buffer) sum += sample * sample
      const rms = Math.sqrt(sum / buffer.length)
      // Коэффициент подобран на глаз: обычная речь с ноутбучного микрофона
      // даёт RMS около 0.05–0.15, и без усиления дорожка была бы плоской.
      const level = Math.min(100, Math.round(rms * 400))
      peaks.push(level)
      onLevel?.(level)
    }, 50)

    const cleanupAudio = () => {
      window.clearInterval(timer)
      source.disconnect()
      void context.close()
    }

    recorder.start(250)
    return new VoiceRecording(
      stream, recorder, chunks, peaks, Date.now(), cleanupAudio,
    )
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  /** Закончить запись и получить её. */
  stop(): Promise<VoiceRecordingResult> {
    return new Promise((resolve) => {
      const finish = () => {
        this.release()
        resolve({
          blob: new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }),
          durationMs: Math.min(this.elapsedMs, MAX_VOICE_MS),
          waveform: resample(this.peaks, WAVEFORM_POINTS),
        })
      }
      // onstop приходит уже после последнего ondataavailable — только к этому
      // моменту в chunks лежит вся запись целиком.
      this.recorder.onstop = finish
      if (this.recorder.state === 'inactive') finish()
      else this.recorder.stop()
    })
  }

  /** Выбросить запись, ничего не отдавая. */
  cancel() {
    if (this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      this.recorder.stop()
    }
    this.release()
  }

  /** Отпустить микрофон. Обязательно: пока дорожка потока жива, в системе
   * горит индикатор «идёт запись», даже если сама запись давно кончилась. */
  private release() {
    this.cleanupAudio()
    for (const track of this.stream.getTracks()) track.stop()
  }
}

/** То, что отдаёт stop(). */
export interface VoiceRecordingResult {
  blob: Blob
  durationMs: number
  /** Пики 0..100, ровно WAVEFORM_POINTS штук — см. resample. */
  waveform: number[]
}

/** Сжать произвольное число замеров ровно до `points` столбиков.
 *
 * Короткая запись дополняется нулями справа, а не растягивается: дорожка из
 * трёх толстых столбов во всю ширину выглядит как ошибка отрисовки, а не как
 * «сообщение на три секунды».
 */
export function resample(values: number[], points: number): number[] {
  if (values.length === 0) return []
  if (values.length <= points) {
    return [...values, ...new Array(points - values.length).fill(0)]
  }
  const step = values.length / points
  const out: number[] = []
  for (let i = 0; i < points; i += 1) {
    const from = Math.floor(i * step)
    const to = Math.max(from + 1, Math.floor((i + 1) * step))
    let peak = 0
    for (let j = from; j < to && j < values.length; j += 1) {
      if (values[j] > peak) peak = values[j]
    }
    out.push(peak)
  }
  return out
}

/** «01:07» — единый формат для таймера записи и для подписи под плеером. */
export function formatVoiceTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
