import { ReactNode, useEffect } from 'react'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import { useSettings } from '../settings'
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

  useEffect(() => {
    if (voice) onStatus(mesh.status)
  }, [voice, mesh.status, onStatus])

  if (!voice) return <>{children}</>
  return (
    <VoiceMeshCtx.Provider value={mesh}>
      {Array.from(mesh.remoteStreams.entries()).map(([uid, stream]) => (
        <audio
          key={uid}
          autoPlay
          muted={mesh.deafened}
          ref={(el) => {
            if (!el) return
            el.srcObject = stream
            el.volume = outputVolume
          }}
        />
      ))}
      {children}
    </VoiceMeshCtx.Provider>
  )
}
