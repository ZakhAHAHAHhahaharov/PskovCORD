import { Video, VideoOff } from 'lucide-react'
import { useVoice } from '../voice'

/** Кнопка камеры — работает только внутри VoiceProvider (в голосе).
 *
 * Значок меняется, а не только подсветка: у выключенной камеры перечёркнутый
 * значок читается однозначно, тогда как «просто не подсвечена» на тёмной
 * панели среди других кнопок теряется. */
export default function CameraButton() {
  const { isCameraOn, toggleCamera } = useVoice()
  return (
    <button
      className={`icon-btn ${isCameraOn ? 'sharing' : ''}`}
      onClick={toggleCamera}
      title={isCameraOn ? 'Выключить камеру' : 'Включить камеру'}
    >
      {isCameraOn ? <Video size={17} /> : <VideoOff size={17} />}
    </button>
  )
}
