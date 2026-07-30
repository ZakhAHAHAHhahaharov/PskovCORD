import {
  MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { api, Channel, Conversation, Member, Me, NameEffect } from '../api'
import type { VoiceState } from '../components/AppShell'
import type { VoiceRosterMember } from '../components/VoiceStage'
import type { VoiceStatus } from '../components/VoiceProvider'
import { conversationDisplayName } from '../conversation'
import { useGateway } from '../gateway'
import {
  playJoinSound,
  playLeaveSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
} from '../sounds'

const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

interface CallParticipant {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  muted: boolean
  deafened: boolean
  sharing_screen: boolean
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
}

interface IncomingCall {
  conversationId: number
  caller: CallParticipant
}

/** Голос/звонки — серверный голосовой канал ИЛИ звонок в диалоге/группе:
 * состояние активного звонка, ростеры, входящий звонок, голосование за мут,
 * звуки входа/выхода/демонстрации. `members` (ростер СЕРВЕРА) и
 * `conversations`/`activeConversation` (домашний домен) читаются отсюда как
 * вход — сам звонок не хранит копию, чтобы не рассинхронизироваться. */
export function useVoiceCall(
  gateway: ReturnType<typeof useGateway>,
  user: Me | null,
  members: Member[],
  channels: Channel[],
  conversations: Conversation[],
  activeConversation: Conversation | null,
  setChannelId: (id: number | null) => void,
  setServerId: (id: number | null) => void,
  setActiveConversationId: (id: number | null) => void,
) {
  const [voice, setVoice] = useState<VoiceState | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('connecting')
  // Актуальный voice для обработчиков событий. Нужен, чтобы решения «мы сейчас
  // в этом канале?» принимались СНАРУЖИ апдейтеров setVoice: React.StrictMode
  // намеренно вызывает апдейтеры дважды, ловя нарушения их чистоты, — и
  // побочки внутри них (alert, отправка в сокет) срабатывали по два раза.
  const voiceRef = useRef<VoiceState | null>(voice)
  voiceRef.current = voice
  // Участники ЗВОНКА в диалоге/группе — параллельно members (те — только
  // для серверных голосовых каналов). id => краткая карточка для отрисовки,
  // приходит прямо в событии (dm_voice_state_update) — отдельно грузить не нужно.
  const [dmCallParticipants, setDmCallParticipants] = useState<Record<number, CallParticipant>>({})
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  // Аналог pendingWatch, но для демонстрации экрана в звонке диалога/группы —
  // отдельное состояние, потому что pendingWatch завязан на channelId сервера.
  const [dmPendingWatchUserId, setDmPendingWatchUserId] = useState<number | null>(null)
  // Высота VoiceStage над текстовым чатом в открытом диалоге/группе — тянется
  // за resize-handle (см. handleDmVoiceStageResizeStart), персональна для
  // сессии (не сохраняется между перезагрузками — не критично).
  const [dmVoiceStageHeight, setDmVoiceStageHeight] = useState(320)
  // userId, чью демонстрацию нужно автоматически начать смотреть в
  // указанном голосовом канале, как только она станет доступна — ставится
  // кликом по бейджу «демка» или по превью в VoiceStage (см. handleWatchScreen).
  const [pendingWatch, setPendingWatch] = useState<{ channelId: number; userId: number } | null>(
    null,
  )
  // channel_id канала, где ПРЯМО СЕЙЧАС идёт голосование за мут (по кому бы
  // то ни было) — используется, только чтобы задизейблить «начать ещё одно»
  // в ParticipantContextMenu; сам факт голосования и его результат живут в
  // muteVote/voice_mute_vote_result отдельно.
  const [activeMuteVoteChannelId, setActiveMuteVoteChannelId] = useState<number | null>(null)
  const [muteVote, setMuteVote] = useState<{
    channelId: number
    targetUserId: number
    endsAt: number
  } | null>(null)

  const dmRoster: VoiceRosterMember[] = Object.values(dmCallParticipants).map((p) => ({
    id: p.id, username: p.username, avatar_color: p.avatar_color, avatar_image: p.avatar_image,
    muted: p.muted, deafened: p.deafened, sharing_screen: p.sharing_screen,
    name_font: p.name_font, name_effect: p.name_effect,
    name_color_1: p.name_color_1, name_color_2: p.name_color_2,
  }))
  const isInDmCall =
    voice?.room.kind === 'conversation' && activeConversation != null && voice.room.id === activeConversation.id

  // Для Блока 2 в StatusMenu (мини-карточка "сейчас в голосовом") — тот же
  // ростер, что уже собирается инлайново для VoiceStage по каналу/диалогу,
  // просто в одном месте и объединённый для обоих видов звонка. У диалогов
  // топика нет (см. api.ts Conversation) — редактируемый статус звонка есть
  // только у серверных голосовых каналов.
  const voiceRoster: VoiceRosterMember[] = useMemo(() => {
    if (voice?.room.kind === 'channel') {
      return members.filter((m) => m.voice_channel === String(voice.room.id))
    }
    if (voice?.room.kind === 'conversation') return dmRoster
    return []
  }, [voice, members, dmRoster])
  const voiceTopic: string | null = useMemo(() => {
    if (voice?.room.kind !== 'channel') return null
    return channels.find((c) => c.id === Number(voice.room.id))?.topic ?? null
  }, [voice, channels])

  const handleJoinVoice = async (ch: Channel) => {
    try {
      const { sfu_url, sfu_token } = await api.voiceCredentials(ch.id)
      setVoiceStatus('connecting')
      // gateway.voiceJoin — это «мета» голоса (presence/roster/call-state) в
      // Django; медиа идёт отдельно через SFU по sfu_url/sfu_token. Честный
      // статус ('connecting'/'failed') считается по факту подключения
      // WebRTC-транспорта к SFU внутри VoiceProvider (onStatus).
      gateway.voiceJoin(ch.id)
      setVoice({ room: { id: ch.id, name: ch.name, kind: 'channel' }, sfuUrl: sfu_url, sfuToken: sfu_token })
      // Клик по голосовому каналу — это и вход в него, и выбор того, что
      // показывать в main (как и для текстовых каналов): переключаем main
      // на VoiceStage этого канала.
      setChannelId(ch.id)
    } catch (e) {
      alert('Не удалось подключиться к голосу: ' + (e as Error).message)
    }
  }

  const handleLeaveVoice = useCallback(() => {
    // Себе самому звук выхода не прилетит через ростер (isChannelVoice/voice
    // уже станут false к моменту, когда эффект ниже увидит изменение members),
    // поэтому играем его явно здесь, в момент собственного выхода.
    playLeaveSound()
    gateway.voiceLeave()
    setVoice(null)
    // Ростер звонка в личке/группе — чисто клиентский стейт, который никто не
    // чистит при выходе: dm_voice_state_update про чужие выходы после нашего
    // уже не придёт (мы вышли из комнаты), а dm_voice_peers при следующем
    // входе только ДОБАВЛЯЕТ пиров к прежнему объекту. Без сброса следующий
    // звонок открывался со всеми, кто был в комнате на момент нашего выхода.
    setDmCallParticipants({})
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
      if (voice?.room.kind !== 'channel' || voice.room.id !== channel.id) {
        void handleJoinVoice(channel)
      }
      setPendingWatch({ channelId: channel.id, userId })
    },
    [channels, voice, setChannelId],
  )

  const handleWatchBadge = useCallback(
    (member: Member) => {
      if (!member.voice_channel) return
      handleWatchScreen(member.id, Number(member.voice_channel))
    },
    [handleWatchScreen],
  )

  const handleDmVoiceJoin = useCallback(
    async (conversationId: number) => {
      try {
        const { sfu_url, sfu_token } = await api.conversationVoiceCredentials(conversationId)
        const conv = conversations.find((c) => c.id === conversationId)
        setVoiceStatus('connecting')
        // Начинаем звонок с пустого ростера: настоящий состав приедет в
        // dm_voice_peers сразу после входа (см. handleLeaveVoice — там же
        // про то, почему на один сброс при выходе полагаться нельзя).
        setDmCallParticipants({})
        gateway.dmVoiceJoin(conversationId)
        setVoice({
          room: {
            id: conversationId,
            name: conv ? conversationDisplayName(conv) : 'Звонок',
            kind: 'conversation',
          },
          sfuUrl: sfu_url,
          sfuToken: sfu_token,
        })
      } catch (e) {
        alert('Не удалось подключиться к звонку: ' + (e as Error).message)
      }
    },
    [gateway, conversations],
  )

  const handleAcceptIncomingCall = useCallback(() => {
    if (!incomingCall) return
    setServerId(null)
    setActiveConversationId(incomingCall.conversationId)
    void handleDmVoiceJoin(incomingCall.conversationId)
    setIncomingCall(null)
  }, [incomingCall, handleDmVoiceJoin, setServerId, setActiveConversationId])

  const handleDeclineIncomingCall = useCallback(() => {
    setIncomingCall(null)
  }, [])

  // Аналог handleWatchScreen, но для звонка в диалоге/группе — раз VoiceStage
  // тут показывается только пока мы УЖЕ в звонке (см. isInDmCall), не нужно
  // ни выбирать канал, ни авто-подключаться, только попросить показ.
  const handleDmRequestWatch = useCallback((userId: number) => {
    setDmPendingWatchUserId(userId)
  }, [])

  // Тянем нижнюю границу VoiceStage над текстовым чатом в открытом диалоге/
  // группе — тот же приём, что и везде в проекте для ресайза (глобальные
  // mousemove/mouseup на document, снимаются в конце драга).
  const dmResizeStartRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const handleDmVoiceStageResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      dmResizeStartRef.current = { startY: e.clientY, startHeight: dmVoiceStageHeight }
      const onMove = (ev: MouseEvent) => {
        const drag = dmResizeStartRef.current
        if (!drag) return
        const next = drag.startHeight + (ev.clientY - drag.startY)
        setDmVoiceStageHeight(Math.max(180, Math.min(next, window.innerHeight - 240)))
      }
      const onUp = () => {
        dmResizeStartRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [dmVoiceStageHeight],
  )

  // Незамеченный звонок сам перестаёт "звонить" — некому его отклонить,
  // если человек просто не смотрит в экран (нет push-уведомлений вне вкладки).
  useEffect(() => {
    if (!incomingCall) return
    const t = setTimeout(() => setIncomingCall(null), 30000)
    return () => clearTimeout(t)
  }, [incomingCall])

  // Реальный статус mesh-соединения (не оптимистичный).
  const handleVoiceStatus = useCallback(
    (status: VoiceStatus) => {
      setVoiceStatus(status)
      if (status !== 'failed') return
      const current = voiceRef.current
      if (!current) return
      gateway.voiceLeave()
      setVoice(null)
      // 'failed' сюда долетает только с самого первого коннекта (ни разу не
      // подключились) — если связь обрывается ПОСЛЕ успешного коннекта,
      // voice.ts бесконечно восстанавливается сам, без алертов и выкидывания
      // из канала (см. handleDropped в voice.ts).
      alert(
        `Не удалось подключиться к голосовому каналу «${current.room.name}». ` +
          'Проверь интернет-соединение (возможна блокировка WebRTC/UDP на твоей сети/VPN) и попробуй зайти снова.',
      )
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
    document.title = voice ? `${voice.room.name} - ${APP_NAME}` : APP_NAME
  }, [voice])

  // Пока мы в голосе — браузер спрашивает подтверждение на закрытие вкладки/
  // перезагрузку. Закрыть страницу случайно, сидя в звонке, слишком легко, а
  // выход из голоса необратим: переподключение — это новый вход в канал со
  // звуком для всех. Текст диалога задаёт сам браузер (свой показать нельзя —
  // спецификация это запрещает), от нас нужен только preventDefault.
  useEffect(() => {
    if (!voice) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Старые браузеры смотрят на returnValue, а не на preventDefault.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [voice])

  // Ростер участников ТЕКУЩЕГО голосового канала СЕРВЕРА — с чистого листа
  // при каждом входе/выходе, чтобы не проигрывать "звук входа" для всех, кто
  // уже был в канале до нас. Диалоги/группы сюда не попадают — их участники
  // не сидят в `members` вообще (это ростер СЕРВЕРА), см. dmCallParticipants
  // и отдельный звуковой эффект ниже.
  const voiceRosterRef = useRef<Set<number>>(new Set())
  const isChannelVoice = voice?.room.kind === 'channel'
  useEffect(() => {
    voiceRosterRef.current = isChannelVoice
      ? new Set(
          members
            .filter((m) => m.voice_channel === String(voice!.room.id))
            .map((m) => m.id),
        )
      : new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChannelVoice, voice?.room.id])

  // Звук при входе/выходе участников звонка, в котором мы сейчас сами —
  // играет для ВСЕХ в канале, включая самого вошедшего/вышедшего (каждый
  // клиент детектит смену ростера у себя локально и проигрывает звук сам).
  useEffect(() => {
    if (!isChannelVoice || !user) return
    const currentIds = new Set(
      members
        .filter((m) => m.voice_channel === String(voice!.room.id))
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
  }, [members, voice, isChannelVoice, user])

  // Тот же звук входа/выхода, но для звонка в диалоге/группе — ростер там
  // приходит через dm_voice_state_update/dm_voice_peers прямо в
  // dmCallParticipants (см. useGatewayEvents), не через members.
  const dmVoiceRosterRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!user) return
    const currentIds = new Set(Object.keys(dmCallParticipants).map(Number))
    const prevIds = dmVoiceRosterRef.current
    for (const id of currentIds) {
      if (!prevIds.has(id)) playJoinSound()
    }
    for (const id of prevIds) {
      if (!currentIds.has(id)) playLeaveSound()
    }
    dmVoiceRosterRef.current = currentIds
  }, [dmCallParticipants, user])

  // Тот же паттерн, что и звук входа/выхода: у кого из участников ТЕКУЩЕГО
  // канала флаг sharing_screen сменился — играем звук старта/стопа демонстрации,
  // тоже всем в канале, включая самого включившего/выключившего показ.
  const voiceSharingRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    voiceSharingRef.current = isChannelVoice
      ? new Set(
          members
            .filter((m) => m.voice_channel === String(voice!.room.id) && m.sharing_screen)
            .map((m) => m.id),
        )
      : new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChannelVoice, voice?.room.id])

  useEffect(() => {
    if (!isChannelVoice || !user) return
    const currentSharing = new Set(
      members
        .filter((m) => m.voice_channel === String(voice!.room.id) && m.sharing_screen)
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
  }, [members, voice, isChannelVoice, user])

  const handleDisconnectUser = useCallback(
    (userId: number) => {
      gateway.voiceDisconnectUser(userId)
    },
    [gateway],
  )

  const handleStartMuteVote = useCallback(
    (userId: number) => {
      // Контекстное меню открывается только для полностью подключённых
      // (см. ChannelSidebar/VoiceStage), но перепроверяем на случай, если
      // соединение отвалилось прямо между открытием меню и кликом.
      if (voiceStatus !== 'connected') return
      gateway.voiceMuteVoteStart(userId)
    },
    [gateway, voiceStatus],
  )

  const handleCastMuteVote = useCallback(
    (forMute: boolean) => {
      gateway.voiceMuteVoteCast(forMute)
      setMuteVote(null)
    },
    [gateway],
  )

  const handleRequestScreenShare = useCallback(
    (userId: number) => {
      if (voiceStatus !== 'connected') return
      gateway.voiceRequestScreenShare(userId)
    },
    [gateway, voiceStatus],
  )

  const handleWakeUser = useCallback(
    (userId: number) => {
      if (voiceStatus !== 'connected') return
      gateway.voiceWakeUser(userId)
    },
    [gateway, voiceStatus],
  )

  return {
    voice, setVoice, voiceRef,
    voiceStatus, setVoiceStatus,
    dmCallParticipants, setDmCallParticipants,
    incomingCall, setIncomingCall,
    dmPendingWatchUserId, setDmPendingWatchUserId,
    dmVoiceStageHeight,
    pendingWatch, setPendingWatch,
    activeMuteVoteChannelId, setActiveMuteVoteChannelId,
    muteVote, setMuteVote,
    dmRoster, isInDmCall, voiceRoster, voiceTopic,
    handleJoinVoice, handleLeaveVoice, handleDmVoiceJoin,
    handleAcceptIncomingCall, handleDeclineIncomingCall,
    handleWatchScreen, handleWatchBadge, handleDmRequestWatch,
    handleDmVoiceStageResizeStart, handleVoiceStatus,
    handleDisconnectUser, handleStartMuteVote, handleCastMuteVote,
    handleRequestScreenShare, handleWakeUser,
  }
}
