import { ReactNode, useEffect } from 'react'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import { useSettings } from '../settings'
import { UserVolumeCtx, useUserVolumeState } from '../userVolume'
import { useVoiceMesh, VoiceMeshCtx, VoiceStatus } from '../voice'
import { VoiceState } from './AppShell'

export type { VoiceStatus } from '../voice'

export default function VoiceProvider({
  voice,
  onStatus,
  children,
}: {
  voice: VoiceState | null
  onStatus: (s: VoiceStatus) => void
  children: ReactNode
}) {
  const gateway = useGateway()
  const { user } = useAuth()
  const { outputVolume } = useSettings()
  const mesh = useVoiceMesh(voice, gateway, user?.id ?? null)
  const userVolume = useUserVolumeState()

  useEffect(() => {
    if (voice) onStatus(mesh.status)
  }, [voice, mesh.status, onStatus])

  // Итог голосования за мут (см. chat.mute_vote.resolve) — персонально нам:
  // реально глушим микрофон и не даём размьютиться раньше срока (см.
  // voice.ts applyForcedMute/toggleMute).
  useEffect(() => {
    return gateway.on('voice_forced_mute', (d) => mesh.applyForcedMute(d.until))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway])

  if (!voice) {
    return <UserVolumeCtx.Provider value={userVolume}>{children}</UserVolumeCtx.Provider>
  }
  return (
    <UserVolumeCtx.Provider value={userVolume}>
      <VoiceMeshCtx.Provider value={mesh}>
        {Array.from(mesh.remoteStreams.entries()).map(([uid, stream]) => (
          <audio
            key={uid}
            autoPlay
            muted={mesh.deafened}
            ref={(el) => {
              if (!el) return
              el.srcObject = stream
              // userVolume — 0..2 (буст громче обычного, см. userVolume.ts), но
              // нативный HTMLMediaElement.volume принимает только 0..1 и КИДАЕТ
              // DOMException "IndexSizeError" за пределами диапазона — именно
              // так ронялась вся страница, стоило кому-то один раз поднять
              // ползунок громкости конкретного участника выше 100% (буст
              // персистится в localStorage, поэтому крash повторялся при
              // каждом новом заходе в канал с этим человеком).
              el.volume = Math.min(1, Math.max(0, outputVolume * userVolume.getUserVolume(uid)))
            }}
          />
        ))}
        {children}
      </VoiceMeshCtx.Provider>
    </UserVolumeCtx.Provider>
  )
}
