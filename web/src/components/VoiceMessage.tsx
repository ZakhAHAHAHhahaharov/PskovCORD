import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { Attachment, mediaUrl } from '../api'
import { formatVoiceTime } from '../voiceRecorder'

/**
 * Голосовое сообщение в ленте: кнопка воспроизведения, дорожка столбиками и
 * подпись «00:10 / 00:41».
 *
 * Дорожка (attachment.waveform) посчитана КЛИЕНТОМ при записи и приехала
 * вместе с файлом — см. voiceRecorder.ts. Поэтому она видна сразу, ещё до
 * того, как браузер скачает сам звук: сообщение выглядит законченным с первого
 * кадра, а не «серым прямоугольником, который вот-вот станет дорожкой».
 *
 * По той же причине здесь не спрашивают длительность у <audio>: у webm из
 * MediaRecorder она в контейнере обычно не проставлена, и audio.duration
 * остаётся Infinity, иногда так и не узнавая себя до конца жизни элемента
 * (известная особенность Chrome с потоковыми/бесконечными webm). Настоящий
 * источник ОБЩЕЙ длительности — attachment.duration_ms, снятый секундомером
 * во время записи, а ТЕКУЩАЯ позиция считается через audio.currentTime,
 * который идёт корректно вне зависимости от того, известна ли браузеру полная
 * длительность файла. Старый код делил currentTime на audio.duration — при
 * Infinity результат всегда 0, то есть бегунок замирал намертво, хотя звук
 * честно играл (ровно тот баг «иногда вообще не бежит»).
 *
 * Плавность — отдельный вопрос: событие timeupdate браузер шлёт всего
 * несколько раз в секунду, и на короткой дорожке это заметно как рывки. Пока
 * идёт воспроизведение, позицию опрашивает requestAnimationFrame — 60 кадров
 * в секунду вместо четырёх.
 *
 * Перемотка сделана на указателе (pointer events), а не на <input range>:
 * дорожка — это и шкала, и картинка одновременно, и класть поверх неё
 * прозрачный ползунок значило бы получить два разных представления одного
 * состояния, которые расходятся на первом же перетаскивании.
 */

/** Столбик ниже этого всё равно рисуется — иначе в паузах речи дорожка
 * рвётся на куски и перестаёт читаться как одна полоса. */
const MIN_BAR_PERCENT = 8

export default function VoiceMessage({ attachment }: { attachment: Attachment }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  // Перетаскивание бегунка: пока оно идёт, положение диктует мышь, а не
  // timeupdate от <audio> — иначе бегунок дёргался бы между пальцем и звуком.
  const [scrubbing, setScrubbing] = useState(false)

  const durationMs = attachment.duration_ms || 0
  const bars = attachment.waveform.length > 0 ? attachment.waveform : null
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0

  /** Доля 0..1 по горизонтали внутри дорожки — общая для клика и для
   * перетаскивания. */
  const fractionAt = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  const seekTo = useCallback(
    (fraction: number) => {
      const clamped = Math.min(1, Math.max(0, fraction))
      const ms = clamped * durationMs
      setPositionMs(ms)
      const audio = audioRef.current
      // currentTime, а не audio.duration * fraction: у файла без известной
      // длительности duration это Infinity, и умножение на него дало бы
      // NaN — перемотка молча ничего не делала бы. durationMs у нас уже
      // есть (секундомер записи), и currentTime считается прямо от него.
      if (audio) audio.currentTime = ms / 1000
    },
    [durationMs],
  )

  // Пока играет — гоним позицию requestAnimationFrame'ом, а не только
  // редкими timeupdate: 60 кадров в секунду вместо четырёх и есть разница
  // между «бегунок ползёт» и «бегунок дёргается».
  useEffect(() => {
    if (!playing || scrubbing) return
    let frame: number
    const tick = () => {
      const audio = audioRef.current
      if (audio) setPositionMs(audio.currentTime * 1000)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, scrubbing])

  // Перетаскивание слушаем на окне, а не на самой дорожке: палец уезжает за
  // её пределы на первом же резком движении, и на элементе события бы
  // кончились ровно там же.
  useEffect(() => {
    if (!scrubbing) return
    const onMove = (e: PointerEvent) => seekTo(fractionAt(e.clientX))
    const onUp = () => setScrubbing(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [scrubbing, seekTo, fractionAt])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => setPlaying(false))
    else audio.pause()
  }

  return (
    <div className={`voice-message ${playing ? 'playing' : ''}`}>
      <button
        type="button"
        className="voice-play"
        title={playing ? 'Пауза' : 'Слушать'}
        onClick={toggle}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      <div className="voice-body">
        <div
          ref={trackRef}
          className="voice-track"
          role="slider"
          aria-label="Перемотка голосового сообщения"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={Math.round(positionMs)}
          tabIndex={0}
          onPointerDown={(e) => {
            // Только левая кнопка: правым кликом по сообщению открывают
            // контекстное меню, и перематывать при этом незачем.
            if (e.button !== 0) return
            setScrubbing(true)
            seekTo(fractionAt(e.clientX))
          }}
          onKeyDown={(e) => {
            // Клавиатурная перемотка — по пять секунд, как в плеерах.
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const step = (e.key === 'ArrowRight' ? 5000 : -5000)
            const next = Math.min(durationMs, Math.max(0, positionMs + step))
            seekTo(durationMs > 0 ? next / durationMs : 0)
          }}
        >
          {bars ? (
            bars.map((peak, i) => (
              <span
                key={i}
                className={`voice-bar ${i / bars.length < progress ? 'played' : ''}`}
                style={{ height: `${Math.max(MIN_BAR_PERCENT, peak)}%` }}
              />
            ))
          ) : (
            // Дорожки нет (запись со старого клиента или её не удалось
            // посчитать) — рисуем ровную полосу: плеер должен работать в любом
            // случае, рисунок тут украшение, а не условие.
            <span className="voice-flat" />
          )}
          <span className="voice-knob" style={{ left: `${progress * 100}%` }} />
        </div>

        <div className="voice-time">
          {formatVoiceTime(positionMs)} / {formatVoiceTime(durationMs)}
        </div>
      </div>

      <audio
        ref={audioRef}
        src={mediaUrl(attachment.url)}
        // metadata, а не auto: в канале таких сообщений может быть десяток
        // подряд, и качать их все ради подписи, которая и так известна из
        // duration_ms, незачем.
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          // Возврат в начало: иначе следующее нажатие «играть» ничего не
          // делает — позиция уже в конце.
          setPositionMs(0)
          if (audioRef.current) audioRef.current.currentTime = 0
        }}
        onTimeUpdate={(e) => {
          if (scrubbing) return
          // Подстраховка на моменты, когда rAF-цикл ещё не запущен (буферизация
          // перед стартом) или уже остановлен (пауза сразу после перемотки —
          // браузер иногда доводит currentTime до ближайшего кейфрейма webm
          // уже ПОСЛЕ события seeked, и этот кадр её подхватывает).
          setPositionMs(e.currentTarget.currentTime * 1000)
        }}
      />
    </div>
  )
}
