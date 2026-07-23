import { ReactNode, useEffect } from 'react'
import { useGateway } from '../gateway'
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
  const mesh = useVoiceMesh(voice, gateway)

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
          ref={(el) => {
            if (el) el.srcObject = stream
          }}
        />
      ))}
      {children}
    </VoiceMeshCtx.Provider>
  )
}
