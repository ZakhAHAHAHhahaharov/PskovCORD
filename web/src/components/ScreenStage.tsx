import { useEffect, useRef } from 'react'
import { Monitor } from 'lucide-react'
import { Member } from '../api'
import { useVoice } from '../voice'

function ScreenTile({
  stream,
  label,
  muted,
}: {
  stream: MediaStream
  label: string
  muted: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return (
    <div className="screen-tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <span className="screen-tile-label">
        <Monitor size={13} /> {label}
      </span>
    </div>
  )
}

/**
 * Область демонстраций экрана участников текущего голосового канала. Пусто,
 * пока никто не демонстрирует. Данные берёт из VoiceProvider (useVoice).
 */
export default function ScreenStage({ members }: { members: Member[] }) {
  const { screenShares, deafened } = useVoice()
  if (screenShares.size === 0) return null
  const nameOf = (uid: number) =>
    members.find((m) => m.id === uid)?.username ?? `Участник ${uid}`
  return (
    <div className="screen-stage">
      {Array.from(screenShares.entries()).map(([uid, stream]) => (
        <ScreenTile key={uid} stream={stream} label={nameOf(uid)} muted={deafened} />
      ))}
    </div>
  )
}
