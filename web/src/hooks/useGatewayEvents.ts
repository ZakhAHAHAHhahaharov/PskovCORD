import { Dispatch, MutableRefObject, SetStateAction, useEffect } from 'react'
import {
  api, Conversation, ConversationMessage, FriendsState, Member, Message, Me, NameEffect, Role, Server,
} from '../api'
import type { VoiceState } from '../components/AppShell'
import { invalidateAvatarAnimation } from '../avatarAnim'
import { useGateway } from '../gateway'
import { outbox } from '../outbox'
import { presenceStore } from '../presence'
import { playLeaveSound, playScreenShareRequestSound, playWakeUpSound } from '../sounds'

interface CallParticipant {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  /** У аватара есть гифка — играет, пока участник говорит (см. avatarAnim.ts).
   * Приезжает только там, где ростер строится из полного профиля
   * (dm_voice_peers → conversation.participants). */
  avatar_animated?: boolean
  muted: boolean
  deafened: boolean
  sharing_screen: boolean
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
  name_anim_speed: number
}

interface IncomingCall {
  conversationId: number
  caller: CallParticipant
}

interface UseGatewayEventsParams {
  gateway: ReturnType<typeof useGateway>
  channelId: number | null
  serverId: number | null
  activeConversationId: number | null
  userRef: MutableRefObject<Me | null | undefined>
  voiceRef: MutableRefObject<VoiceState | null>
  conversationsRef: MutableRefObject<Conversation[]>
  serversRef: MutableRefObject<Server[]>
  messagesRef: MutableRefObject<Message[]>
  dmMessagesRef: MutableRefObject<ConversationMessage[]>
  channelServerIdRef: MutableRefObject<Record<number, number>>
  shouldNotifyRef: MutableRefObject<(ownerServerId: number, authorId: number, content: string) => boolean>
  /** Кого я игнорирую — их сообщения не поднимают непрочитанное. Ref, а не
   * значение: см. комментарий про зависимости эффекта ниже. */
  ignoredUserIdsRef: MutableRefObject<Set<number>>
  fetchedServerDataIds: MutableRefObject<Set<number>>
  setMessages: Dispatch<SetStateAction<Message[]>>
  setMembers: Dispatch<SetStateAction<Member[]>>
  setServers: Dispatch<SetStateAction<Server[]>>
  setServerRoles: Dispatch<SetStateAction<Record<number, Role[]>>>
  setServerMembersCache: Dispatch<SetStateAction<Record<number, Member[]>>>
  setUnreadChannelIds: Dispatch<SetStateAction<Set<number>>>
  setChannelId: (id: number | null) => void
  setServerId: (id: number | null) => void
  setVoice: Dispatch<SetStateAction<VoiceState | null>>
  setDmCallParticipants: Dispatch<SetStateAction<Record<number, CallParticipant>>>
  setActiveMuteVoteChannelId: Dispatch<SetStateAction<number | null>>
  setMuteVote: Dispatch<SetStateAction<{ channelId: number; targetUserId: number; endsAt: number } | null>>
  setIncomingCall: Dispatch<SetStateAction<IncomingCall | null>>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setDmMessages: Dispatch<SetStateAction<ConversationMessage[]>>
  setUnreadConversationIds: Dispatch<SetStateAction<Set<number>>>
  setActiveConversationId: (id: number | null) => void
  setFriends: Dispatch<SetStateAction<FriendsState>>
}

/** Вся realtime-подписка на gateway (~30 op'ов) в одном месте: сообщения
 * канала, участники/присутствие/голос сервера, домашний экран (диалоги/
 * звонки/друзья), членство на сервере, дозагрузка пропущенного на "ready".
 * Каждый (пере)монтируется вместе с эффектом ниже — параметры-ref'ы (см.
 * shouldNotifyRef/voiceRef/conversationsRef и т.п. по всему AppShell)
 * специально НЕ висят в зависимостях эффекта: иначе любое быстро меняющееся
 * состояние (новое сообщение, новый диалог) пересоздавало бы все ~30
 * обработчиков подряд, и сообщение, пришедшее в окне между отпиской и
 * подпиской, могло бы потеряться. */
export function useGatewayEvents(params: UseGatewayEventsParams) {
  const {
    gateway, channelId, serverId, activeConversationId,
    userRef, voiceRef, conversationsRef, serversRef, messagesRef, dmMessagesRef,
    channelServerIdRef, shouldNotifyRef, ignoredUserIdsRef, fetchedServerDataIds,
    setMessages, setMembers, setServers, setServerRoles, setServerMembersCache,
    setUnreadChannelIds, setChannelId, setServerId, setVoice, setDmCallParticipants,
    setActiveMuteVoteChannelId, setMuteVote, setIncomingCall,
    setConversations, setDmMessages, setUnreadConversationIds, setActiveConversationId,
    setFriends,
  } = params

  // Realtime-события gateway.
  useEffect(() => {
    const offMsg = gateway.on('message_create', (d) => {
      // Эхо собственной отправки: nonce закрывает статус «отправляется» и
      // убирает оптимистичную копию из очереди — настоящее сообщение
      // добавляется тут же строкой ниже (см. outbox.ack).
      if (d.nonce) outbox.ack(d.nonce)
      if (d.message.channel === channelId) {
        setMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
        )
        return
      }
      // Не открытый прямо сейчас канал — решаем, поднимать ли непрочитанное
      // (мьют/уровень уведомлений/упоминание, см. shouldNotifyForChannel).
      const ownerServerId = channelServerIdRef.current[d.message.channel]
      if (
        ownerServerId != null &&
        !ignoredUserIdsRef.current.has(d.message.author.id) &&
        shouldNotifyRef.current(ownerServerId, d.message.author.id, d.message.content)
      ) {
        setUnreadChannelIds((prev) =>
          prev.has(d.message.channel) ? prev : new Set(prev).add(d.message.channel),
        )
      }
    })
    // Подтверждение ПОВТОРНОЙ попытки: сообщение создала прошлая, эхо до нас
    // не дошло. Само сообщение доберётся обычным путём (перечитыванием
    // истории на "ready"), здесь важно лишь снять статус «отправляется».
    const offMsgAck = gateway.on('message_ack', (d) => {
      if (d.nonce) outbox.ack(d.nonce)
    })
    const offMsgNack = gateway.on('message_nack', (d) => {
      if (d.nonce) outbox.nack(d.nonce, d.reason)
    })
    const offReactions = gateway.on('message_reactions', (d) => {
      if (d.channel_id !== channelId) return
      setMessages((prev) =>
        prev.map((m) => (m.id === d.message_id ? { ...m, reactions: d.reactions } : m)),
      )
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
      // Общий стор статусов — им живут все аватарки ВНЕ ростера сервера
      // (друзья, диалоги, пикеры; см. presence.ts). Сам ростер по-прежнему
      // держит статус в своём Member ниже: там он приходит уже вместе со
      // списком и участвует в группировке «в сети/не в сети».
      presenceStore.set(d.user_id, d.status)
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
            display_name: d.display_name ?? '',
            avatar_color: d.avatar_color,
            avatar_image: d.avatar_image ?? '',
            // Гифка-аватар (см. avatarAnim.ts) — как и стиль ника ниже,
            // приедет со следующим полным api.members(); до тех пор аватар
            // просто не анимируется.
            avatar_animated: false,
            avatar_downloadable: true,
            banner_gradient: '',
            banner_image: '',
            // Стиль ника (см. nameStyle.ts) сюда не приезжает — так же, как и
            // роли ниже, уточнится следующим полным api.members(). До тех
            // пор ник рисуется как обычный текст, без стиля.
            name_font: null,
            name_effect: 'standard',
            name_color_1: '',
            name_color_2: '',
            name_anim_speed: 1,
            online: true,
            status: 'online' as const,
            voice_channel: vc,
            muted: false,
            deafened: false,
            sharing_screen: false,
            // Роли/владение/ник на сервере приходят только из api.members() —
            // здесь их нет, ставим пустые: строка ростера ими не пользуется, а
            // редактор сервера работает с перезагруженным списком
            // (reloadMembers).
            role_ids: [],
            is_owner: false,
            server_nickname: '',
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
      // Тот же op обслуживает и звонки в диалогах/группах (сервер сам
      // различает по текущей комнате — см. chat.consumers._send_to_room_group);
      // применяем и туда, если этот userId сейчас в roster'е звонка.
      setDmCallParticipants((prev) =>
        prev[d.user_id]
          ? { ...prev, [d.user_id]: { ...prev[d.user_id], muted: !!d.muted, deafened: !!d.deafened } }
          : prev,
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
      setDmCallParticipants((prev) =>
        prev[d.user_id]
          ? { ...prev, [d.user_id]: { ...prev[d.user_id], sharing_screen: !!d.sharing } }
          : prev,
      )
    })
    // Нас принудительно отключили от голосового канала (см.
    // handleDisconnectUser/chat.consumers._handle_voice_disconnect_user).
    const offVoiceKicked = gateway.on('voice_kicked', (d) => {
      const current = voiceRef.current
      if (!current || current.room.kind !== 'channel' || current.room.id !== d.channel_id) {
        return
      }
      gateway.voiceLeave()
      setVoice(null)
      // Свой звук выхода — здесь, единственный раз за кик: диф ростера в
      // useVoiceCall себя самого намеренно не озвучивает (см. комментарий
      // там), иначе на кик приходилось два звука подряд.
      playLeaveSound()
      alert('Вас отключили от голосового канала.')
    })
    // Голос начался на другом устройстве/вкладке того же аккаунта (см.
    // chat.consumers._kick_other_devices) — один аккаунт не может быть в
    // голосе на двух устройствах разом. voice_leave здесь НЕ шлём: presence
    // на сервере уже атомарно указывает на НОВОЕ устройство (см.
    // presence.join_voice), обычный voice_leave стёр бы именно её.
    const offVoiceKickedOtherDevice = gateway.on('voice_kicked_other_device', () => {
      if (!voiceRef.current) return
      setVoice(null)
      alert('Вы подключились к голосу с другого устройства — здесь звонок завершён.')
    })
    // Новое голосование за мут в каком-то голосовом канале сервера — модалку
    // показываем, только если это канал, в котором мы сейчас сами сидим, и
    // цель — не мы (у цели голосования такого меню/модалки просто нет).
    const offMuteVoteStart = gateway.on('voice_mute_vote_start', (d) => {
      setActiveMuteVoteChannelId(d.channel_id)
      setMuteVote((prev) => {
        const current = voiceRef.current
        if (
          current?.room.kind === 'channel' &&
          current.room.id === d.channel_id &&
          d.target_user_id !== userRef.current?.id
        ) {
          return { channelId: d.channel_id, targetUserId: d.target_user_id, endsAt: d.ends_at }
        }
        return prev
      })
    })
    const offMuteVoteResult = gateway.on('voice_mute_vote_result', (d) => {
      setActiveMuteVoteChannelId((prev) => (prev === d.channel_id ? null : prev))
      setMuteVote((prev) => (prev && prev.channelId === d.channel_id ? null : prev))
    })
    // Кто-то из того же голосового канала попросил нас включить демонстрацию —
    // только звук (см. задачу), никакой модалки.
    const offScreenShareRequested = gateway.on('voice_screen_share_requested', (d) => {
      const current = voiceRef.current
      if (current?.room.kind === 'channel' && current.room.id === d.channel_id) {
        playScreenShareRequestSound()
      }
    })
    // «Разбудить мальчика» — кто-то из того же канала будит нас (см.
    // ParticipantContextMenu), пока у нас выключен микрофон или звук.
    // Нарочно противный звук, а не тихий пинг, как у демонстрации выше.
    const offWakeRequested = gateway.on('voice_wake_requested', (d) => {
      const current = voiceRef.current
      if (current?.room.kind === 'channel' && current.room.id === d.channel_id) {
        playWakeUpSound()
      }
    })
    // Смена ника/аватара — свою уже применили локально сразу после ответа
    // PATCH /api/auth/me (см. handleProfileUpdated), но остальным участникам
    // и старым сообщениям в списке нужно обновиться этим же событием.
    const offProfileUpdate = gateway.on('profile_update', (d) => {
      // Аватар мог смениться — гифка, уже лежащая в кэше, теперь от прежнего
      // (см. avatarAnim.ts): без сброса она проигрывалась бы поверх нового
      // статичного кадра до перезагрузки вкладки.
      invalidateAvatarAnimation(d.user_id)
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id
            ? {
                ...m,
                username: d.username,
                display_name: d.display_name,
                avatar_color: d.avatar_color,
                avatar_image: d.avatar_image,
                avatar_animated: !!d.avatar_animated,
                avatar_downloadable: d.avatar_downloadable !== false,
                name_font: d.name_font,
                name_effect: d.name_effect,
                name_color_1: d.name_color_1,
                name_color_2: d.name_color_2,
                name_anim_speed: d.name_anim_speed,
              }
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
    // Статус канала подправили правым кликом → «Установить статус канала»
    // (см. ChannelDetail.patch на бэке) — персистентное поле Channel.status,
    // в отличие от эфемерного CallTopic (voice_call_state/CallTopic.tsx).
    const offChannelUpdate = gateway.on('channel_update', (d) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === d.server_id
            ? { ...s, channels: s.channels.map((c) => (c.id === d.channel.id ? d.channel : c)) }
            : s,
        ),
      )
    })
    // Кому-то поменяли никнейм НА СЕРВЕРЕ (см. backend ServerMemberNickname) —
    // публичный, поэтому обновляем ростер у всех, а не только у того, кто
    // правил. Событие приходит и самому инициатору: он уже применил ответ
    // ручки локально, и повторная запись того же значения ничего не меняет.
    const offMemberNickname = gateway.on('server_member_nickname', (d) => {
      if (d.server_id !== serverId) return
      setMembers((prev) =>
        prev.map((m) =>
          m.id === d.user_id ? { ...m, server_nickname: d.nickname } : m,
        ),
      )
    })
    // Настройки сервера изменил кто-то другой (редактор сервера). Свои
    // права (my_permissions) в событие не кладутся — они у каждого свои,
    // поэтому мержим только «общие» поля поверх уже загруженного сервера.
    const offServerUpdate = gateway.on('server_update', (d) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === d.server.id
            ? { ...s, ...d.server, channels: s.channels, my_permissions: s.my_permissions }
            : s,
        ),
      )
    })
    // Нашу заявку на вступление одобрили — сервер появляется в списке сразу.
    const offJoinApproved = gateway.on('server_join_approved', (d) => {
      setServers((prev) => (prev.some((s) => s.id === d.server.id) ? prev : [...prev, d.server]))
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

    // --- домашний экран: диалоги/группы/друзья/звонки ---------------------
    const offDmReactions = gateway.on('dm_message_reactions', (d) => {
      if (d.conversation_id !== activeConversationId) return
      setDmMessages((prev) =>
        prev.map((m) => (m.id === d.message_id ? { ...m, reactions: d.reactions } : m)),
      )
    })
    const offDmMsg = gateway.on('dm_message_create', (d) => {
      if (d.nonce) outbox.ack(d.nonce)
      if (d.message.conversation === activeConversationId) {
        setDmMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message],
        )
      }
      // Непрочитанное — чужое сообщение в диалог, который прямо сейчас не
      // открыт (домашний экран должен быть виден И это должен быть именно
      // этот диалог — activeConversationId не сбрасывается при переходе на
      // сервер, поэтому одной проверки id диалога недостаточно).
      const isViewingThisConversation =
        serverId == null && d.message.conversation === activeConversationId
      if (
        d.message.author.id !== userRef.current?.id &&
        !isViewingThisConversation &&
        // «Игнорировать» — сообщение приходит и видно, но о нём не
        // сигналим (см. chat.models.UserRelationState.ignored).
        !ignoredUserIdsRef.current.has(d.message.author.id)
      ) {
        setUnreadConversationIds((prev) =>
          prev.has(d.message.conversation) ? prev : new Set(prev).add(d.message.conversation),
        )
      }
      // Превью последнего сообщения в списке диалогов — обновляем всегда,
      // даже если сейчас открыт другой диалог.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === d.message.conversation
            ? {
                ...c,
                last_message: {
                  content: d.message.content,
                  author_id: d.message.author.id,
                  created_at: d.message.created_at,
                },
              }
            : c,
        ),
      )
    })
    const offDmMsgDelete = gateway.on('dm_message_delete', (d) => {
      if (d.conversation_id !== activeConversationId) return
      setDmMessages((prev) => prev.filter((m) => m.id !== d.message_id))
    })
    const offDmMsgUpdate = gateway.on('dm_message_update', (d) => {
      if (d.message.conversation !== activeConversationId) return
      setDmMessages((prev) => prev.map((m) => (m.id === d.message.id ? d.message : m)))
    })
    const offConversationCreate = gateway.on('conversation_create', (d) => {
      setConversations((prev) =>
        prev.some((c) => c.id === d.conversation.id)
          ? prev.map((c) => (c.id === d.conversation.id ? d.conversation : c))
          : [d.conversation, ...prev],
      )
    })
    const offDmVoice = gateway.on('dm_voice_state_update', (d) => {
      // Ростер звонка привязан к комнате АКТИВНОГО ЗВОНКА (voice.room), а не
      // к тому, чей диалог сейчас открыт в чате — можно писать в одном
      // диалоге, оставаясь в звонке другого.
      const activeCall = voiceRef.current
      if (activeCall?.room.kind !== 'conversation' || activeCall.room.id !== d.conversation_id) {
        return
      }
      setDmCallParticipants((prev) => {
        const next = { ...prev }
        if (d.in_call) {
          next[d.user_id] = {
            id: d.user_id, username: d.username,
            avatar_color: d.avatar_color, avatar_image: d.avatar_image,
            muted: false, deafened: false, sharing_screen: false,
            // Стиль ника сюда не приезжает (см. аналогичный комментарий у
            // voice_state_update выше) — участник уже виден в
            // conv.participants (User), но конкретно этот payload — только
            // id/username/avatar. Уточнится при следующей загрузке диалога.
            name_font: null,
            name_effect: 'standard',
            name_color_1: '',
            name_color_2: '',
            name_anim_speed: 1,
          }
        } else {
          delete next[d.user_id]
        }
        return next
      })
    })
    // Начальный список пиров сразу после СВОЕГО входа в звонок — приходит
    // только с id (без username/аватара), достаём их из уже загруженных
    // participants активного диалога (см. api.conversations()).
    const offDmPeers = gateway.on('dm_voice_peers', (d) => {
      const activeCall = voiceRef.current
      if (activeCall?.room.kind !== 'conversation' || activeCall.room.id !== d.conversation_id) {
        return
      }
      const conv = conversationsRef.current.find((c) => c.id === d.conversation_id)
      const lookup = new Map((conv?.participants ?? []).map((p) => [p.id, p]))
      const peerFlags = (d.peer_flags ?? {}) as Record<
        number, { muted?: boolean; deafened?: boolean; sharing_screen?: boolean }
      >
      setDmCallParticipants((prev) => {
        const next = { ...prev }
        for (const id of d.peer_ids as number[]) {
          const p = lookup.get(id)
          if (p) {
            const flags = peerFlags[id] ?? {}
            next[id] = {
              id: p.id, username: p.username,
              avatar_color: p.avatar_color, avatar_image: p.avatar_image,
              avatar_animated: p.avatar_animated,
              muted: !!flags.muted, deafened: !!flags.deafened,
              sharing_screen: !!flags.sharing_screen,
              name_font: p.name_font,
              name_effect: p.name_effect,
              name_color_1: p.name_color_1,
              name_color_2: p.name_color_2,
              name_anim_speed: p.name_anim_speed,
            }
          }
        }
        return next
      })
    })
    const offCallRing = gateway.on('conversation_call_ring', (d) => {
      // Не звоним сами себе, если уже в этом звонке (второй таб/устройство).
      const activeCall = voiceRef.current
      if (activeCall?.room.kind === 'conversation' && activeCall.room.id === d.conversation_id) {
        return
      }
      setIncomingCall({ conversationId: d.conversation_id, caller: d.caller })
    })
    const offFriendRequestCreate = gateway.on('friend_request_create', (d) => {
      setFriends((prev) => ({
        ...prev,
        incoming: [...prev.incoming, { id: d.id, user: d.from_user }],
      }))
    })
    const offFriendRequestAccept = gateway.on('friend_request_accept', (d) => {
      setFriends((prev) => ({
        friends: [...prev.friends, d.user],
        incoming: prev.incoming.filter((r) => r.id !== d.id),
        outgoing: prev.outgoing.filter((r) => r.id !== d.id),
      }))
    })

    // Каждый (пере)коннект gateway начинается с "ready". Пока сокет лежал,
    // сообщения продолжали приходить другим — а этот клиент их не получал и
    // раньше не добирал никогда: они не появлялись до переключения канала.
    // Курсор after=<последний известный id> закрывает ровно этот разрыв.
    const offReady = gateway.on('ready', () => {
      // Сокет снова жив — немедленно повторяем всё, что висит неотправленным,
      // не дожидаясь их собственных таймеров ретрая. Дубля не будет: сервер
      // узнаёт попытку по nonce (см. chat/consumers.py).
      outbox.flush()
      void (async () => {
        const lastMessage = messagesRef.current[messagesRef.current.length - 1]
        if (channelId != null && lastMessage) {
          try {
            const missed = await api.messages(channelId, { after: lastMessage.id })
            if (missed.length) {
              setMessages((prev) => {
                const known = new Set(prev.map((m) => m.id))
                return [...prev, ...missed.filter((m) => !known.has(m.id))]
              })
            }
          } catch {
            /* добор не критичен — история перечитается при смене канала */
          }
        }
        const lastDm = dmMessagesRef.current[dmMessagesRef.current.length - 1]
        if (activeConversationId != null && lastDm) {
          try {
            const missed = await api.conversationMessages(activeConversationId, {
              after: lastDm.id,
            })
            if (missed.length) {
              setDmMessages((prev) => {
                const known = new Set(prev.map((m) => m.id))
                return [...prev, ...missed.filter((m) => !known.has(m.id))]
              })
            }
          } catch {
            /* см. выше */
          }
        }
      })()
    })

    // Членство на сервере изменилось при живом сокете. Сама подписка/отписка
    // от группы сервера делается на стороне консьюмера (см. chat/consumers.py,
    // op'ы server_membership_*) — здесь только приводим UI в соответствие.
    const offMembershipGranted = gateway.on('server_membership_granted', () => {
      void (async () => {
        try {
          setServers(await api.servers())
        } catch {
          /* перечитаем при следующем событии */
        }
      })()
    })
    const offMembershipRevoked = gateway.on('server_membership_revoked', (d) => {
      setServers((prev) => prev.filter((s) => s.id !== d.server_id))
      // Чистим и всё, что было насчитано/закэшировано для этого сервера —
      // иначе кэши ролей/ростеров/непрочитанного растут по серверам, из
      // которых давно вышли.
      const leaving = serversRef.current.find((s) => s.id === d.server_id)
      if (leaving) {
        const leavingChannelIds = new Set(leaving.channels.map((c) => c.id))
        setUnreadChannelIds((prev) => {
          if (![...leavingChannelIds].some((id) => prev.has(id))) return prev
          const next = new Set(prev)
          leavingChannelIds.forEach((id) => next.delete(id))
          return next
        })
      }
      fetchedServerDataIds.current.delete(d.server_id)
      setServerRoles((prev) => {
        if (!(d.server_id in prev)) return prev
        const next = { ...prev }
        delete next[d.server_id]
        return next
      })
      setServerMembersCache((prev) => {
        if (!(d.server_id in prev)) return prev
        const next = { ...prev }
        delete next[d.server_id]
        return next
      })
      if (serverId === d.server_id) {
        setServerId(null)
        setChannelId(null)
      }
    })
    // Мы сами вышли из беседы (см. api.leaveConversation).
    const offConversationLeft = gateway.on('conversation_left', (d) => {
      setConversations((prev) => prev.filter((c) => c.id !== d.conversation_id))
      if (activeConversationId === d.conversation_id) setActiveConversationId(null)
    })
    // Из беседы вышел кто-то другой — убрать из списка участников и из
    // ростера звонка, если он там был.
    const offParticipantLeave = gateway.on('conversation_participant_leave', (d) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === d.conversation_id
            ? { ...c, participants: c.participants.filter((p) => p.id !== d.user_id) }
            : c,
        ),
      )
      setDmCallParticipants((prev) => {
        if (!prev[d.user_id]) return prev
        const next = { ...prev }
        delete next[d.user_id]
        return next
      })
    })

    return () => {
      offMsg()
      offMsgAck()
      offMsgNack()
      offReactions()
      offDmReactions()
      offMsgDelete()
      offMsgUpdate()
      offPresence()
      offVoice()
      offMicStatus()
      offScreenShare()
      offVoiceKicked()
      offVoiceKickedOtherDevice()
      offMuteVoteStart()
      offMuteVoteResult()
      offScreenShareRequested()
      offWakeRequested()
      offProfileUpdate()
      offChannelCreate()
      offChannelUpdate()
      offMemberNickname()
      offServerUpdate()
      offJoinApproved()
      offCallState()
      offDmMsg()
      offDmMsgDelete()
      offDmMsgUpdate()
      offConversationCreate()
      offDmVoice()
      offDmPeers()
      offCallRing()
      offFriendRequestCreate()
      offFriendRequestAccept()
      offMembershipGranted()
      offMembershipRevoked()
      offConversationLeft()
      offParticipantLeave()
      offReady()
    }
    // conversations/voice/user намеренно НЕ в зависимостях: они читаются
    // через ref'ы выше. Иначе каждое входящее ЛС (setConversations) снимало и
    // заново вешало все обработчики этого эффекта — см. комментарий у
    // conversationsRef. Остальные setState-сеттеры и ref'ы стабильны между
    // рендерами (React гарантирует identity useState-сеттеров; ref'ы сюда
    // приходят параметром из тех же родительских хуков и тоже не меняются) —
    // не в зависимостях по той же причине, что и раньше, до вынесения этого
    // эффекта в отдельный хук.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, channelId, serverId, activeConversationId])
}
