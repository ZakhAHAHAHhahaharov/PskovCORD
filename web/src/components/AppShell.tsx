import { useCallback, useEffect, useRef, useState, MouseEvent as ReactMouseEvent } from 'react'
import { api, Channel, Member, Message, Server } from '../api'
import { useAuth } from '../auth'
import { useGateway } from '../gateway'
import {
  playJoinSound,
  playLeaveSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
} from '../sounds'
import ServerRail from './ServerRail'
import ChannelSidebar from './ChannelSidebar'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import MembersList from './MembersList'
import VoiceProvider, { VoiceStatus } from './VoiceProvider'
import VoiceStage from './VoiceStage'
import DiscoverModal from './DiscoverModal'
import SettingsModal from './SettingsModal'
import ProfileModal from './ProfileModal'
import MiniProfilePopup, { ProfilePopupTarget, ProfilePopupUser } from './MiniProfilePopup'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

export interface VoiceState {
  channel: Channel
  /** WS-адрес сигналинга SFU и токен доступа (из voice-credentials). */
  sfuUrl: string
  sfuToken: string
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
  const [showSettings, setShowSettings] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [profilePopup, setProfilePopup] = useState<ProfilePopupTarget | null>(null)
  const [replyTarget, setReplyTarget] = useState<Message | null>(null)
  const [editTarget, setEditTarget] = useState<Message | null>(null)
  // userId, чью демонстрацию нужно автоматически начать смотреть в
  // указанном голосовом канале, как только она станет доступна — ставится
  // кликом по бейджу «демка» или по превью в VoiceStage (см. handleWatchScreen).
  const [pendingWatch, setPendingWatch] = useState<{ channelId: number; userId: number } | null>(
    null,
  )

  const currentServer = servers.find((s) => s.id === serverId) || null
  const channels = currentServer?.channels || []
  const currentChannel = channels.find((c) => c.id === channelId) || null
  const isServerOwner = currentServer?.owner === user?.id

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
    setReplyTarget(null)
    setEditTarget(null)
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
    const offMsgDelete = gateway.on('message_delete', (d) => {
      if (d.channel_id !== channelId) return
      setMessages((prev) => prev.filter((m) => m.id !== d.message_id))
    })
    const offMsgUpdate = gateway.on('message_update', (d) => {
      if (d.message.channel !== channelId) return
      setMessages((prev) =>
        prev.map((m) => (m.id === d.message.id ? d.message : m)),
      )
    })
    const offPresence = gateway.on('presence_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, online: d.online, status: d.status } : m,
        ),
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
        // Раз он в голосе — статус по умолчанию 'online' (voice_state_update
        // не несёт эффективный статус; уточнится следующим presence_update).
        return [
          ...prev,
          {
            id: d.user_id,
            username: d.username,
            avatar_color: d.avatar_color,
            avatar_image: d.avatar_image ?? '',
            banner_gradient: '',
            banner_image: '',
            online: true,
            status: 'online' as const,
            voice_channel: vc,
            muted: false,
            deafened: false,
            sharing_screen: false,
          },
        ]
      })
    })
    // Статус мьюта/дефена — глобально для всех, не только для тех, кто сам
    // в этом голосовом канале (иначе кольцо/значки видны только "изнутри").
    const offMicStatus = gateway.on('voice_mute_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, muted: !!d.muted, deafened: !!d.deafened } : m,
        ),
      )
    })
    // Демонстрация экрана — тоже глобально, чтобы бейдж «демка» и клик по
    // нему работали даже для тех, кто сам не подключён к этому каналу.
    const offScreenShare = gateway.on('voice_screen_share_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, sharing_screen: !!d.sharing } : m,
        ),
      )
    })
    // Смена ника/аватара — свою уже применили локально сразу после ответа
    // PATCH /api/auth/me (см. handleProfileUpdated), но остальным участникам
    // и старым сообщениям в списке нужно обновиться этим же событием.
    const offProfileUpdate = gateway.on('profile_update', (d) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id
            ? { ...m, username: d.username, avatar_color: d.avatar_color, avatar_image: d.avatar_image }
            : m,
        ),
      )
    })
    const offChannelCreate = gateway.on('channel_create', (d) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === d.server_id
            ? {
                ...s,
                channels: s.channels.some((c) => c.id === d.channel.id)
                  ? s.channels
                  : [...s.channels, d.channel],
              }
            : s,
        ),
      )
    })
    const offCallState = gateway.on('voice_call_state', (d) => {
      setServers((prev) =>
        prev.map((s) => ({
          ...s,
          channels: s.channels.map((c) =>
            c.id === d.channel_id
              ? { ...c, call_started_at: d.call_started_at, topic: d.topic }
              : c,
          ),
        })),
      )
    })
    return () => {
      offMsg()
      offMsgDelete()
      offMsgUpdate()
      offPresence()
      offVoice()
      offMicStatus()
      offScreenShare()
      offProfileUpdate()
      offChannelCreate()
      offCallState()
    }
  }, [gateway, channelId, serverId])

  const openProfilePopup = useCallback((popupUser: ProfilePopupUser, e: ReactMouseEvent) => {
    e.stopPropagation()
    setProfilePopup({ user: popupUser, x: e.clientX, y: e.clientY })
  }, [])

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
    if (channelId == null) return
    gateway.sendMessage(channelId, content, replyTarget?.id ?? null)
    setReplyTarget(null)
  }

  const handleDeleteMessage = (messageId: number) => {
    gateway.deleteMessage(messageId)
  }

  const handleReplyRequest = (m: Message) => {
    setEditTarget(null)
    setReplyTarget(m)
  }

  const handleEditRequest = (m: Message) => {
    setReplyTarget(null)
    setEditTarget(m)
  }

  const handleSaveEdit = (messageId: number, content: string) => {
    gateway.editMessage(messageId, content)
    setEditTarget(null)
  }

  const handleJoinVoice = async (ch: Channel) => {
    try {
      const { sfu_url, sfu_token } = await api.voiceCredentials(ch.id)
      setVoiceStatus('connecting')
      // gateway.voiceJoin — это «мета» голоса (presence/roster/call-state) в
      // Django; медиа идёт отдельно через SFU по sfu_url/sfu_token. Честный
      // статус ('connecting'/'failed') считается по факту подключения
      // WebRTC-транспорта к SFU внутри VoiceProvider (onStatus).
      gateway.voiceJoin(ch.id)
      setVoice({ channel: ch, sfuUrl: sfu_url, sfuToken: sfu_token })
      // Клик по голосовому каналу — это и вход в него, и выбор того, что
      // показывать в main (как и для текстовых каналов): переключаем main
      // на VoiceStage этого канала.
      setChannelId(ch.id)
    } catch (e) {
      alert('Не удалось подключиться к голосу: ' + (e as Error).message)
    }
  }

  const handleLeaveVoice = useCallback(() => {
    gateway.voiceLeave()
    setVoice(null)
  }, [gateway])

  // Единая точка входа для просмотра демонстрации экрана — используется и
  // кликом по бейджу «демка» в сайдбаре (для ЛЮБОГО голосового канала на
  // сервере), и кликом по превью внутри VoiceStage (для текущего канала).
  // Переключает main на нужный канал, при необходимости подключается к
  // голосу (как обычный клик по каналу), а сам просмотр запускает VoiceStage
  // через pendingWatch, как только демонстрация станет доступна в SFU.
  const handleWatchScreen = useCallback(
    (userId: number, targetChannelId: number) => {
      const channel = channels.find((c) => c.id === targetChannelId)
      if (!channel) return
      setChannelId(channel.id)
      if (voice?.channel.id !== channel.id) {
        void handleJoinVoice(channel)
      }
      setPendingWatch({ channelId: channel.id, userId })
    },
    [channels, voice],
  )

  const handleWatchBadge = useCallback(
    (member: Member) => {
      if (!member.voice_channel) return
      handleWatchScreen(member.id, Number(member.voice_channel))
    },
    [handleWatchScreen],
  )

  // Реальный статус mesh-соединения (не оптимистичный).
  const handleVoiceStatus = useCallback(
    (status: VoiceStatus) => {
      setVoiceStatus(status)
      if (status === 'failed') {
        setVoice((v) => {
          if (v) {
            gateway.voiceLeave()
            // 'failed' сюда долетает только с самого первого коннекта (ни разу
            // не подключились) — если связь обрывается ПОСЛЕ успешного коннекта,
            // voice.ts сам бесконечно пытается восстановиться сам, без алертов
            // и выкидывания из канала (см. handleDropped в voice.ts).
            alert(
              `Не удалось подключиться к голосовому каналу «${v.channel.name}». ` +
                'Проверь интернет-соединение (возможна блокировка WebRTC/UDP на твоей сети/VPN) и попробуй зайти снова.',
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

  // Заголовок вкладки — имя голосового канала, в котором мы сейчас сидим
  // (как в Discord), иначе просто название приложения.
  useEffect(() => {
    document.title = voice ? `${voice.channel.name} - ${APP_NAME}` : APP_NAME
  }, [voice])

  // Ростер участников ТЕКУЩЕГО голосового канала — с чистого листа при
  // каждом входе/выходе, чтобы не проигрывать "звук входа" для всех, кто
  // уже был в канале до нас.
  const voiceRosterRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    voiceRosterRef.current = voice
      ? new Set(
          members
            .filter((m) => m.voice_channel === String(voice.channel.id))
            .map((m) => m.id),
        )
      : new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.channel.id])

  // Звук при входе/выходе участников звонка, в котором мы сейчас сами —
  // играет для ВСЕХ в канале, включая самого вошедшего/вышедшего (каждый
  // клиент детектит смену ростера у себя локально и проигрывает звук сам).
  useEffect(() => {
    if (!voice || !user) return
    const currentIds = new Set(
      members
        .filter((m) => m.voice_channel === String(voice.channel.id))
        .map((m) => m.id),
    )
    const prevIds = voiceRosterRef.current
    for (const id of currentIds) {
      if (!prevIds.has(id)) playJoinSound()
    }
    for (const id of prevIds) {
      if (!currentIds.has(id)) playLeaveSound()
    }
    voiceRosterRef.current = currentIds
  }, [members, voice, user])

  // Тот же паттерн, что и звук входа/выхода: у кого из участников ТЕКУЩЕГО
  // канала флаг sharing_screen сменился — играем звук старта/стопа демонстрации,
  // тоже всем в канале, включая самого включившего/выключившего показ.
  const voiceSharingRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    voiceSharingRef.current = voice
      ? new Set(
          members
            .filter((m) => m.voice_channel === String(voice.channel.id) && m.sharing_screen)
            .map((m) => m.id),
        )
      : new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.channel.id])

  useEffect(() => {
    if (!voice || !user) return
    const currentSharing = new Set(
      members
        .filter((m) => m.voice_channel === String(voice.channel.id) && m.sharing_screen)
        .map((m) => m.id),
    )
    const prevSharing = voiceSharingRef.current
    for (const id of currentSharing) {
      if (!prevSharing.has(id)) playScreenShareStartSound()
    }
    for (const id of prevSharing) {
      if (!currentSharing.has(id)) playScreenShareStopSound()
    }
    voiceSharingRef.current = currentSharing
  }, [members, voice, user])

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
        onOpenSettings={() => setShowSettings(true)}
        onOpenProfile={() => setShowProfile(true)}
        onWatchScreen={handleWatchBadge}
      />

      <main className={`chat ${currentChannel?.kind === 'voice' ? 'chat-voice' : ''}`}>
        {currentChannel && currentChannel.kind === 'voice' ? (
          <VoiceStage
            channel={currentChannel}
            members={members}
            selfUserId={user!.id}
            pendingWatchUserId={
              pendingWatch?.channelId === currentChannel.id ? pendingWatch.userId : null
            }
            onConsumedPendingWatch={() => setPendingWatch(null)}
            onRequestWatch={(userId) => handleWatchScreen(userId, currentChannel.id)}
            onOpenProfile={openProfilePopup}
          />
        ) : currentChannel && currentChannel.kind === 'text' ? (
          <>
            <header className="chat-header">
              <span className="hash">#</span>
              <span className="chat-header-name">{currentChannel.name}</span>
            </header>
            <MessageList
              messages={messages}
              currentUserId={user!.id}
              canModerate={isServerOwner}
              editingId={editTarget?.id ?? null}
              onDelete={handleDeleteMessage}
              onEditRequest={handleEditRequest}
              onReply={handleReplyRequest}
              onOpenProfile={openProfilePopup}
            />
            <MessageInput
              channelName={currentChannel.name}
              onSend={handleSend}
              replyTarget={replyTarget}
              onCancelReply={() => setReplyTarget(null)}
              editTarget={editTarget}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={() => setEditTarget(null)}
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

      <MembersList members={members} channels={channels} onOpenProfile={openProfilePopup} />

      {showDiscover && (
        <DiscoverModal
          onClose={() => setShowDiscover(false)}
          onJoined={handleJoined}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} onLogout={logout} />
      )}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {profilePopup && (
        <MiniProfilePopup
          target={profilePopup}
          currentUserId={user!.id}
          onClose={() => setProfilePopup(null)}
        />
      )}
    </div>
    </VoiceProvider>
  )
}
