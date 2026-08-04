import { useCallback, useEffect, useState } from 'react'
import { api, Channel, InvitePreview, Server } from '../api'

/** Ссылки-приглашения: и на сервер целиком (?invite=, редимпшен сразу), и в
 * конкретный канал — текстовый или голосовой (?voiceInvite=, сначала
 * предпросмотр, вступление по явному клику; параметр в URL остался старым
 * именем не просто так — он появился, когда приглашать можно было только в
 * голосовой, а переименовывать query-параметр значило бы ломать уже
 * разосланные ссылки), плюс "Приглашение" карточкой в переписке
 * (server_invite/dm_message).
 *
 * `onEnterChannel` — что значит «попасть» в приглашённый канал: для
 * голосового это подключение (handleJoinVoice из useVoiceCall), для
 * текстового — просто выбор его в сайдбаре (см. AppShell, там оба случая
 * сведены в одну функцию по channel.kind). */
export function useInviteLinks(
  servers: Server[],
  setServers: React.Dispatch<React.SetStateAction<Server[]>>,
  selectServer: (s: Server) => void,
  onEnterChannel: (ch: Channel) => void | Promise<void>,
) {
  const [voiceInvite, setVoiceInvite] = useState<{
    code: string
    preview: InvitePreview | null
    loading: boolean
    error: string
  } | null>(null)

  // Ссылка-приглашение (?invite=<код>) — редимпшен один раз при загрузке.
  // Параметр убирается из URL сразу: ссылка многоразовая, но повторно дёргать
  // API на каждый ре-рендер/перезагрузку той же вкладки незачем.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const code = params.get('invite')
    if (!code) return
    const url = new URL(location.href)
    url.searchParams.delete('invite')
    window.history.replaceState({}, '', url.toString())
    void (async () => {
      try {
        const server = await api.redeemServerInvite(code)
        setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]))
        selectServer(server)
      } catch (e) {
        alert('Не удалось войти по ссылке-приглашению: ' + (e as Error).message)
      }
    })()
  }, [selectServer, setServers])

  // Ссылка-приглашение в конкретный голосовой канал (?voiceInvite=<код>) —
  // в отличие от ?invite= выше, НЕ вступает мгновенно: сначала грузим
  // предпросмотр (см. backend InvitePreview) и показываем подтверждение
  // (VoiceInviteJoinModal), само вступление — только по явному клику там.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const code = params.get('voiceInvite')
    if (!code) return
    const url = new URL(location.href)
    url.searchParams.delete('voiceInvite')
    window.history.replaceState({}, '', url.toString())
    setVoiceInvite({ code, preview: null, loading: true, error: '' })
    void (async () => {
      try {
        const preview = await api.invitePreview(code)
        setVoiceInvite({ code, preview, loading: false, error: '' })
      } catch (e) {
        setVoiceInvite({ code, preview: null, loading: false, error: (e as Error).message })
      }
    })()
  }, [])

  // Приглашение теперь карточка прямо в сообщении диалога (см.
  // ServerInviteCard/MessageList) — статус на ней обновится сам, живым
  // dm_message_update от бэкенда (см. chat.views._broadcast_invite_message_update),
  // отдельно патчить локальное состояние не нужно.
  const handleAcceptServerInvite = async (inviteId: number) => {
    try {
      const server = await api.acceptServerInvite(inviteId)
      setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]))
      selectServer(server)
      // Приглашение было в конкретный канал (см. ChannelInviteModal) — сразу
      // заходим в него, а не просто открываем сервер.
      if (server.invited_channel_id != null) {
        const ch = server.channels.find((c) => c.id === server.invited_channel_id)
        if (ch) onEnterChannel(ch)
      }
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleDeclineServerInvite = useCallback(async (inviteId: number) => {
    try {
      await api.declineServerInvite(inviteId)
    } catch (e) {
      alert((e as Error).message)
    }
  }, [])

  const handleOpenInvitedServer = useCallback((targetServerId: number) => {
    const server = servers.find((s) => s.id === targetServerId)
    if (server) selectServer(server)
  }, [servers, selectServer])

  // Подтверждение из VoiceInviteJoinModal — вступаем (если ещё не участник)
  // и сразу подключаемся к каналу, тем же путём, что и приглашение-карточка
  // в переписке (см. handleAcceptServerInvite).
  const handleConfirmVoiceInvite = async () => {
    if (!voiceInvite) return
    try {
      const server = await api.redeemServerInvite(voiceInvite.code)
      setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]))
      selectServer(server)
      if (server.invited_channel_id != null) {
        const ch = server.channels.find((c) => c.id === server.invited_channel_id)
        if (ch) onEnterChannel(ch)
      }
      setVoiceInvite(null)
    } catch (e) {
      alert('Не удалось подключиться: ' + (e as Error).message)
    }
  }

  return {
    voiceInvite, setVoiceInvite,
    handleAcceptServerInvite, handleDeclineServerInvite,
    handleOpenInvitedServer, handleConfirmVoiceInvite,
  }
}
