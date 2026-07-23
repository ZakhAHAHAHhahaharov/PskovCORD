import { useCallback, useEffect, useState } from 'react'
import { api, Channel, Member, Message, Server } from '../api'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import ServerRail from './ServerRail'
import ChannelSidebar from './ChannelSidebar'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import MembersList from './MembersList'
import VoiceProvider, { VoiceStatus } from './VoiceProvider'
import DiscoverModal from './DiscoverModal'

export interface VoiceState {
  channel: Channel
  iceServers: RTCIceServer[]
}

export default function AppShell() {
  const { user, logout } = useAuth()
  const gateway = useGateway()

  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState<number | null>(null)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [voice, setVoice] = useState<VoiceState | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('connecting')
  const [showDiscover, setShowDiscover] = useState(false)

  const currentServer = servers.find((s) => s.id === serverId) || null
  const channels = currentServer?.channels || []
  const currentChannel = channels.find((c) => c.id === channelId) || null

  const selectServer = useCallback((s: Server) => {
    setServerId(s.id)
    const firstText = s.channels.find((c) => c.kind === 'text')
    setChannelId(firstText ? firstText.id : s.channels[0]?.id ?? null)
  }, [])

  // Начальная загрузка серверов.
  useEffect(() => {
    ;(async () => {
      const list = await api.servers()
      setServers(list)
      if (list.length) selectServer(list[0])
    })()
  }, [selectServer])

  // Участники при смене сервера.
  useEffect(() => {
    if (serverId == null) return
    ;(async () => {
      try {
        setMembers(await api.members(serverId))
      } catch {
        setMembers([])
      }
    })()
  }, [serverId])

  // История сообщений при смене текстового канала.
  useEffect(() => {
    if (!currentChannel || currentChannel.kind !== 'text') {
      setMessages([])
      return
    }
    ;(async () => {
      try {
        setMessages(await api.messages(currentChannel.id))
      } catch {
        setMessages([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  // Realtime-события gateway.
  useEffect(() => {
    const offMsg = gateway.on('message_create', (d) => {
      if (d.message.channel === channelId) {
        setMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
        )
      }
    })
    const offPresence = gateway.on('presence_update', (d) => {
      setMembers((prev) =>
        prev.map((m) => (m.id === d.user_id ? { ...m, online: d.online } : m)),
      )
    })
    const offVoice = gateway.on('voice_state_update', (d) => {
      if (d.server_id !== serverId) return // событие не про текущий сервер
      const vc = d.channel_id ? String(d.channel_id) : null
      setMembers((prev) => {
        if (prev.some((m) => m.id === d.user_id)) {
          return prev.map((m) =>
            m.id === d.user_id ? { ...m, voice_channel: vc, online: true } : m,
          )
        }
        // Участник, которого ещё не было в загруженном списке — добавляем сразу.
        return [
          ...prev,
          {
            id: d.user_id,
            username: d.username,
            avatar_color: d.avatar_color,
            online: true,
            voice_channel: vc,
          },
        ]
      })
    })
    return () => {
      offMsg()
      offPresence()
      offVoice()
    }
  }, [gateway, channelId, serverId])

  const handleCreateServer = async () => {
    const name = window.prompt('Название сервера:')?.trim()
    if (!name) return
    const s = await api.createServer(name)
    setServers((prev) => [...prev, s])
    selectServer(s)
  }

  const handleJoined = (s: Server) => {
    setServers((prev) =>
      prev.some((x) => x.id === s.id) ? prev : [...prev, s],
    )
    selectServer(s)
    setShowDiscover(false)
  }

  const handleCreateChannel = async (kind: 'text' | 'voice') => {
    if (serverId == null) return
    const name = window.prompt(
      kind === 'text' ? 'Имя текстового канала:' : 'Имя голосового канала:',
    )?.trim()
    if (!name) return
    const ch = await api.createChannel(serverId, name, kind)
    setServers((prev) =>
      prev.map((s) =>
        s.id === serverId ? { ...s, channels: [...s.channels, ch] } : s,
      ),
    )
  }

  const handleSend = (content: string) => {
    if (channelId != null) gateway.sendMessage(channelId, content)
  }

  const handleJoinVoice = async (ch: Channel) => {
    try {
      const { ice_servers } = await api.voiceCredentials(ch.id)
      setVoiceStatus('connecting')
      // gateway.voiceJoin шлём сразу (не после подключения, как раньше для
      // LiveKit): в mesh это же сообщение приносит список пиров, без него
      // соединяться не с кем. Честный статус ('connecting'/'failed') теперь
      // считается по фактическому состоянию RTCPeerConnection'ов внутри
      // VoiceProvider (onStatus), а не по факту join.
      gateway.voiceJoin(ch.id)
      setVoice({ channel: ch, iceServers: ice_servers })
    } catch (e) {
      alert('Не удалось подключиться к голосу: ' + (e as Error).message)
    }
  }

  const handleLeaveVoice = useCallback(() => {
    gateway.voiceLeave()
    setVoice(null)
  }, [gateway])

  // Реальный статус mesh-соединения (не оптимистичный).
  const handleVoiceStatus = useCallback(
    (status: VoiceStatus) => {
      setVoiceStatus(status)
      if (status === 'failed') {
        setVoice((v) => {
          if (v) {
            gateway.voiceLeave()
            alert(
              `Не удалось подключиться к голосовому каналу «${v.channel.name}». ` +
                'Проверь интернет-соединение (возможна блокировка WebRTC/UDP на твоей сети/VPN) и попробуй снова.',
            )
          }
          return null
        })
      }
    },
    [gateway],
  )

  // Если подключение зависло дольше 15с — считаем его неудавшимся.
  useEffect(() => {
    if (!voice || voiceStatus !== 'connecting') return
    const t = setTimeout(() => handleVoiceStatus('failed'), 15000)
    return () => clearTimeout(t)
  }, [voice, voiceStatus, handleVoiceStatus])

  return (
    <VoiceProvider voice={voice} onStatus={handleVoiceStatus}>
    <div className="app">
      <ServerRail
        servers={servers}
        activeId={serverId}
        onSelect={selectServer}
        onCreate={handleCreateServer}
        onDiscover={() => setShowDiscover(true)}
      />

      <ChannelSidebar
        server={currentServer}
        channels={channels}
        activeChannelId={channelId}
        members={members}
        voice={voice}
        voiceStatus={voiceStatus}
        user={user!}
        onSelectText={(c) => setChannelId(c.id)}
        onJoinVoice={handleJoinVoice}
        onLeaveVoice={handleLeaveVoice}
        onCreateChannel={handleCreateChannel}
        onLogout={logout}
      />

      <main className="chat">
        {currentChannel && currentChannel.kind === 'text' ? (
          <>
            <header className="chat-header">
              <span className="hash">#</span>
              <span className="chat-header-name">{currentChannel.name}</span>
            </header>
            <MessageList messages={messages} />
            <MessageInput
              channelName={currentChannel.name}
              onSend={handleSend}
            />
          </>
        ) : (
          <div className="chat-empty">
            {currentServer
              ? 'Выбери текстовый канал слева'
              : 'Создай сервер или зайди в существующий'}
          </div>
        )}
      </main>

      <MembersList members={members} channels={channels} />

      {showDiscover && (
        <DiscoverModal
          onClose={() => setShowDiscover(false)}
          onJoined={handleJoined}
        />
      )}
    </div>
    </VoiceProvider>
  )
}
