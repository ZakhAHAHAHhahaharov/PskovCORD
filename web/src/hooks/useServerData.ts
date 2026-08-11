import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api, Channel, ChannelMemberSettings, ChannelNotifyLevel, Me, Member, NotificationLevel,
  Role, Server, ServerMemberSettings,
} from '../api'
import { useContextMenuState } from '../contextMenuStack'
import { customEmojiStore, loadMyEmoji } from '../customEmoji'
import { isMentioned } from '../mentions'
import { presenceStore } from '../presence'
import { loadMyStickers } from '../stickers'

/** Серверы/каналы/участники/роли — весь "серверный" домен AppShell: список
 * серверов и выбранного сервера/канала, ростер и роли (свои и фоновых
 * серверов), непрочитанные/заглушенные, плюс CRUD и модалки, завязанные на
 * конкретный сервер/канал (контекстные меню, настройки, приглашения). */
export function useServerData(userRef: RefObject<Me | null>) {
  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState<number | null>(null)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [showDiscover, setShowDiscover] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)

  // --- уведомления серверов: роли/ростеры всех серверов, непрочитанные ---
  // Роли и полные ростеры (с role_ids) ВСЕХ серверов, где мы состоим — нужны
  // для подсчёта упоминаний (см. mentions.ts) в ФОНОВЫХ серверах: `members`
  // выше — только ростер сейчас ВЫБРАННОГО сервера. Дружеский масштаб
  // проекта (см. комментарии по всему бэку) делает такую загрузку разумной.
  const [serverRoles, setServerRoles] = useState<Record<number, Role[]>>({})
  const [serverMembersCache, setServerMembersCache] = useState<Record<number, Member[]>>({})
  const fetchedServerDataIds = useRef<Set<number>>(new Set())
  const serversRef = useRef<Server[]>([])
  serversRef.current = servers

  // --- кастомные эмодзи и стикеры ------------------------------------------
  // Наборы грузятся один раз на сессию: они нужны не только пикеру, но и
  // отрисовке уже пришедших сообщений, то есть практически сразу и везде
  // (см. customEmoji.ts, stickers.ts).
  useEffect(() => {
    void loadMyEmoji()
    void loadMyStickers()
  }, [])

  // Каталог серверов для пикера — порядок вкладок, значки и права добавлять/
  // управлять. Отдельно от самих эмодзи: /api/emoji не знает про сервер БЕЗ
  // эмодзи, а именно в такой чаще всего и добавляют первый.
  useEffect(() => {
    customEmojiStore.setCatalog(
      servers.map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon || '',
        canAdd: !!s.my_permissions?.create_expressions,
        canManage: !!s.my_permissions?.manage_expressions,
      })),
    )
  }, [servers])

  // Непрочитанные текстовые каналы — тот же приём, что и unreadConversationIds
  // в домашнем домене: чисто клиентское, эфемерное состояние (сбрасывается
  // при перезагрузке страницы), наполняется в message_create (см.
  // useGatewayEvents), чистится при открытии канала/«Отметить как
  // прочитанное» (см. handleSelectChannel/handleMarkServerRead).
  const [unreadChannelIds, setUnreadChannelIds] = useState<Set<number>>(new Set())

  // Раз в 30с — форсирует пересчёт "заглушено ли ПРЯМО СЕЙЧАС": muted_until
  // может истечь без единого нового события, и без этого тика бейдж/пункт
  // меню молча оставались бы "заглушено" ещё сколько-то после истечения.
  const [muteTick, setMuteTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setMuteTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // --- контекстное меню сервера (правый клик в ServerRail) и его модалки ---
  // Держим только id, не сам объект: настройки в серверном меню (мьют,
  // уровень уведомлений) меняются кликом ВНУТРИ этого же меню — со снимком
  // сервера, захваченным в момент правого клика, чекбоксы после клика не
  // обновились бы, потому что patchServerSettings меняет `servers`, а не
  // этот снимок. Резолвим актуальный объект из `servers` при каждом рендере.
  const [serverContextMenuServerId, setServerContextMenuServerId] = useContextMenuState<{
    id: number
    x: number
    y: number
  }>()
  const [showServerInviteId, setShowServerInviteId] = useState<number | null>(null)
  const [showServerPrivacyId, setShowServerPrivacyId] = useState<number | null>(null)
  // --- контекстное меню голосового канала (правый клик, см. ChannelContextMenu) ---
  // Тот же приём, что и у serverContextMenuServerId выше — храним только id
  // канала и координаты, сам канал резолвим из currentServer при рендере,
  // чтобы не работать со стухшим снимком после live-обновлений (channel_update).
  const [channelContextMenuId, setChannelContextMenuId] = useContextMenuState<{
    id: number
    x: number
    y: number
  }>()
  const [showChannelInviteId, setShowChannelInviteId] = useState<number | null>(null)
  // «Настроить канал» из контекстного меню — та же логика хранения id, что и
  // у showChannelInviteId выше (резолвим актуальный канал из currentServer
  // при рендере, а не таскаем снимок).
  const [showChannelSettingsId, setShowChannelSettingsId] = useState<number | null>(null)

  const currentServer = servers.find((s) => s.id === serverId) || null
  const channels = currentServer?.channels || []
  const currentChannel = channels.find((c) => c.id === channelId) || null

  // --- уведомления серверов: производные значения --------------------------
  const isServerMutedNow = useCallback((s: Server): boolean => {
    const settings = s.my_settings
    if (!settings) return false
    if (settings.muted_forever) return true
    if (!settings.muted_until) return false
    return new Date(settings.muted_until).getTime() > Date.now()
  }, [])

  // muteTick форсирует пересчёт по таймеру (см. выше) — сам он в теле не
  // используется (isServerMutedNow сверяется с Date.now() напрямую), только
  // как повод для React пересчитать useMemo; поэтому линтер и не видит его
  // "нужным" — но без него пересчёт не произойдёт вовсе, пока не изменится
  // сам список серверов.
  const mutedServerIds = useMemo(
    () => new Set(servers.filter((s) => isServerMutedNow(s)).map((s) => s.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [servers, isServerMutedNow, muteTick],
  )

  const unreadServerIds = useMemo(() => {
    const ids = new Set<number>()
    for (const s of servers) {
      if (s.channels.some((c) => unreadChannelIds.has(c.id))) ids.add(s.id)
    }
    return ids
  }, [servers, unreadChannelIds])

  // channel_id -> server_id, для message_create по ФОНОВОМУ каналу (там
  // приходит только id канала, не сервера).
  const channelServerId = useMemo(() => {
    const map: Record<number, number> = {}
    for (const s of servers) {
      for (const c of s.channels) map[c.id] = s.id
    }
    return map
  }, [servers])

  // Полный ростер сервера: для СЕЙЧАС открытого — свежий `members`, для
  // фоновых — кэш (см. serverMembersCache выше, чуть менее свежий).
  const membersForServer = useCallback(
    (id: number): Member[] => (id === serverId ? members : serverMembersCache[id] ?? []),
    [serverId, members, serverMembersCache],
  )
  const rolesForServer = useCallback(
    (id: number): Role[] => serverRoles[id] ?? [],
    [serverRoles],
  )

  // Поднимать ли непрочитанное на сообщение из чужого канала — с учётом
  // мьюта, уровня уведомлений и (при notification_level='mentions')
  // упоминания — личного, @all/@here или ролевого (см. mentions.ts).
  const shouldNotifyForChannel = useCallback(
    (ownerServerId: number, authorId: number, content: string): boolean => {
      if (authorId === userRef.current?.id) return false
      const server = serversRef.current.find((s) => s.id === ownerServerId)
      const settings = server?.my_settings
      if (!server || !settings) return true
      if (isServerMutedNow(server)) return false
      if (settings.notification_level === 'none') return false
      if (settings.notification_level === 'all') return true
      const roster = membersForServer(ownerServerId)
      const me = roster.find((m) => m.id === userRef.current?.id)
      const author = roster.find((m) => m.id === authorId)
      return isMentioned(content, {
        myUsername: userRef.current?.username ?? '',
        myRoleIds: me?.role_ids ?? [],
        authorRoleIds: author?.role_ids ?? [],
        roles: rolesForServer(ownerServerId),
        ignoreAtHere: settings.ignore_at_here,
        suppressRoleMentions: settings.suppress_role_mentions,
      })
    },
    [isServerMutedNow, membersForServer, rolesForServer, userRef],
  )
  // Читается ИЗ большого gateway-эффекта через ref — тот, как и voiceRef/
  // conversationsRef рядом, намеренно не держит быстро меняющиеся значения в
  // зависимостях (иначе каждое новое сообщение фонового сервера
  // пересоздавало бы все ~30 обработчиков подряд).
  const shouldNotifyRef = useRef(shouldNotifyForChannel)
  shouldNotifyRef.current = shouldNotifyForChannel
  const channelServerIdRef = useRef<Record<number, number>>({})
  channelServerIdRef.current = channelServerId

  const selectServer = useCallback((s: Server) => {
    setServerId(s.id)
    const firstText = s.channels.find((c) => c.kind === 'text')
    const target = firstText ? firstText.id : (s.channels[0]?.id ?? null)
    setChannelId(target)
    // Ветка чужого сервера в панели не имеет смысла — см. handleSelectChannel.
    setOpenThreadId(null)
    // Заодно гасим непрочитанное у канала, в который переключаемся — иначе
    // клик по серверу открывал бы канал, у которого пилюля всё ещё "непрочитан".
    if (target != null) {
      setUnreadChannelIds((prev) => {
        if (!prev.has(target)) return prev
        const next = new Set(prev)
        next.delete(target)
        return next
      })
    }
  }, [])

  // Начальная загрузка серверов. Ссылка на ветку (?thread=<id>, см.
  // handleCopyThreadLink) разбирается прямо здесь: открыть ветку можно только
  // ПОСЛЕ того, как список серверов приехал — до этого неизвестно ни в каком
  // она сервере, ни в каком канале.
  useEffect(() => {
    ;(async () => {
      const list = await api.servers()
      setServers(list)
      const params = new URLSearchParams(location.search)
      const threadParam = Number(params.get('thread'))
      if (threadParam) {
        // Параметр убираем сразу: перезагрузка страницы не должна снова
        // насильно открывать ветку, которую человек уже закрыл (тот же приём,
        // что и у ?voiceInvite=, см. useInviteLinks).
        const url = new URL(location.href)
        url.searchParams.delete('thread')
        window.history.replaceState({}, '', url.toString())
        const owner = list.find((s) => s.channels.some((c) => c.id === threadParam))
        const thread = owner?.channels.find((c) => c.id === threadParam)
        if (owner && thread && thread.parent != null) {
          setServerId(owner.id)
          setChannelId(thread.parent)
          setOpenThreadId(thread.id)
          return
        }
        // Ветка не нашлась — её удалили либо к ней нет доступа (приватная,
        // куда не звали). Открываем как обычно и молчим: ссылка могла быть
        // и не нам предназначена.
      }
      if (list.length) selectServer(list[0])
    })()
  }, [selectServer])

  // Участники при смене сервера. Отдельным callback'ом, потому что после
  // выдачи роли/кика/бана из редактора сервера список нужно перечитать.
  const reloadMembers = useCallback(async () => {
    if (serverId == null) return
    try {
      const list = await api.members(serverId)
      // Ростер — второй (после /api/presence) источник чужих статусов:
      // сокомандников по серверу видно и вне его — в пикерах «новый
      // диалог»/«пригласить» и в автокомплите @упоминаний, где своего
      // статуса у строки нет (см. presence.ts).
      presenceStore.merge(list.map((m) => ({ user_id: m.id, status: m.status })))
      setMembers(list)
    } catch {
      setMembers([])
    }
  }, [serverId])

  // Роли — отдельным callback'ом по той же причине: правка/создание/удаление
  // роли в редакторе сервера (вкладка «Роли») меняет ТОЛЬКО его собственный
  // локальный стейт (RolesTab), а MembersList в правом сайдбаре читает роли
  // из serverRoles здесь же — без переоткрытия сервера тот кэш иначе не
  // обновлялся вообще, и группировка/цвет/имя роли в сайдбаре отставали от
  // редактора до перезагрузки страницы.
  const reloadRoles = useCallback(async () => {
    if (serverId == null) return
    try {
      const list = await api.roles(serverId)
      setServerRoles((prev) => ({ ...prev, [serverId]: list }))
    } catch {
      /* используем то, что уже в кэше */
    }
  }, [serverId])

  useEffect(() => {
    void reloadMembers()
  }, [reloadMembers])

  // Роли + полный ростер КАЖДОГО сервера, где мы состоим — один раз на
  // сервер (см. serverRoles/serverMembersCache выше). Список серверов меняется
  // редко (вступил/вышел), поэтому дозагружаем только НОВЫЕ id.
  useEffect(() => {
    const toFetch = servers.filter((s) => !fetchedServerDataIds.current.has(s.id))
    if (toFetch.length === 0) return
    toFetch.forEach((s) => fetchedServerDataIds.current.add(s.id))
    void (async () => {
      for (const s of toFetch) {
        try {
          const [roleList, memberList] = await Promise.all([api.roles(s.id), api.members(s.id)])
          presenceStore.merge(memberList.map((m) => ({ user_id: m.id, status: m.status })))
          setServerRoles((prev) => ({ ...prev, [s.id]: roleList }))
          setServerMembersCache((prev) => ({ ...prev, [s.id]: memberList }))
        } catch {
          // Не удалось — попробуем снова при следующем изменении списка
          // серверов (вступление/выход куда угодно перезапускает этот эффект).
          fetchedServerDataIds.current.delete(s.id)
        }
      }
    })()
  }, [servers])

  // Роли ИМЕННО открытого сейчас сервера освежаем при каждом переключении —
  // используются и для подсчёта упоминаний, и потенциально устарели в общем
  // кэше выше (кто-то мог поправить mentionable_by, пока сервер был фоновым).
  useEffect(() => {
    if (serverId == null) return
    void (async () => {
      try {
        const list = await api.roles(serverId)
        setServerRoles((prev) => ({ ...prev, [serverId]: list }))
      } catch {
        /* используем то, что уже в кэше */
      }
    })()
  }, [serverId])

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

  // Сохранение из редактора сервера — ответ PATCH уже содержит свежий сервер
  // со всеми полями и правами, остальным он уедет через server_update.
  const handleServerUpdated = useCallback((updated: Server) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }, [])

  // --- уведомления/мьют/приватность/приглашения/выход сервера -------------
  // «Прочитанные» предупреждения канала со спойлерами (Channel.is_spoiler,
  // вкладка «Обзор» → «Видимость контента») — только в рамках этой сессии
  // вкладки: спойлер предупреждает один раз за заход, а не при каждом клике
  // по уже открытому сегодня каналу. В ref, не в state — сама по себе
  // отметка не должна вызывать перерисовку.
  const acknowledgedSpoilerIds = useRef<Set<number>>(new Set())
  const handleSelectChannel = useCallback((c: Channel) => {
    if (c.is_spoiler && !acknowledgedSpoilerIds.current.has(c.id)) {
      if (!window.confirm(
        `«${c.name}» — канал со спойлерами: обсуждения и темы здесь могут ` +
          'быть чувствительными. Продолжить и открыть канал?',
      )) {
        return
      }
      acknowledgedSpoilerIds.current.add(c.id)
    }
    setChannelId(c.id)
    // Ушли в другой канал — открытая ветка закрывается вместе с разговором,
    // ответвлением от которого была: панель рядом с ЧУЖИМ каналом не значила
    // бы ничего. Возврат в тот же канал ветку не восстанавливает — открыть её
    // снова стоит один клик по строке в сайдбаре.
    setOpenThreadId(null)
    setUnreadChannelIds((prev) => {
      if (!prev.has(c.id)) return prev
      const next = new Set(prev)
      next.delete(c.id)
      return next
    })
  }, [])

  const handleMarkServerRead = useCallback((s: Server) => {
    const ids = new Set(s.channels.map((c) => c.id))
    setUnreadChannelIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of ids) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
  }, [])

  /** «Пометить как прочитанное» из контекстного меню канала — в отличие от
   * handleSelectChannel (тот тоже гасит бейдж, но только как побочный эффект
   * открытия), это явное действие ещё и продвигает персистентный курсор
   * прочтения на бэкенде (см. api.markChannelRead, PR с ChannelReadState) —
   * иначе следующий заход в канал снова вывел бы на первое «непрочитанное»,
   * хотя человек только что явно сказал, что прочитал всё. Не ждём ответа:
   * бейдж гасим сразу, а неудачный запрос страшен не больше, чем если бы
   * его не было — тогда просто следующий заход не будет учитывать эту
   * отметку. */
  const handleMarkChannelRead = useCallback((c: Channel) => {
    setUnreadChannelIds((prev) => {
      if (!prev.has(c.id)) return prev
      const next = new Set(prev)
      next.delete(c.id)
      return next
    })
    void api.markChannelRead(c.id).catch(() => {})
  }, [])

  // Оптимистичный патч my_settings конкретного сервера — используется и для
  // мгновенного отклика на клик (до ответа сервера), и чтобы применить сам
  // ответ (полный актуальный payload с сервера).
  const patchServerSettings = useCallback(
    (serverIdValue: number, patch: Partial<ServerMemberSettings>) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverIdValue
            ? { ...s, my_settings: { ...s.my_settings, ...patch } }
            : s,
        ),
      )
    },
    [],
  )

  const handleMuteServer = useCallback(
    async (s: Server, minutes: number | 'forever') => {
      patchServerSettings(s.id, {
        muted: true,
        muted_forever: minutes === 'forever',
        muted_until: minutes === 'forever' ? null : s.my_settings.muted_until,
      })
      try {
        const updated = await api.updateServerSettings(
          s.id,
          minutes === 'forever' ? { mute_forever: true } : { mute_minutes: minutes },
        )
        patchServerSettings(s.id, updated)
      } catch (e) {
        alert('Не удалось заглушить сервер: ' + (e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleUnmuteServer = useCallback(
    async (s: Server) => {
      patchServerSettings(s.id, { muted: false, muted_forever: false, muted_until: null })
      try {
        const updated = await api.updateServerSettings(s.id, { unmute: true })
        patchServerSettings(s.id, updated)
      } catch (e) {
        alert('Не удалось снять заглушение: ' + (e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleSetNotificationLevel = useCallback(
    async (s: Server, level: NotificationLevel) => {
      patchServerSettings(s.id, { notification_level: level })
      try {
        await api.updateServerSettings(s.id, { notification_level: level })
      } catch (e) {
        alert('Не удалось изменить параметры уведомлений: ' + (e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleToggleIgnoreAtHere = useCallback(
    async (s: Server, value: boolean) => {
      patchServerSettings(s.id, { ignore_at_here: value })
      try {
        await api.updateServerSettings(s.id, { ignore_at_here: value })
      } catch (e) {
        alert((e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleToggleSuppressRoleMentions = useCallback(
    async (s: Server, value: boolean) => {
      patchServerSettings(s.id, { suppress_role_mentions: value })
      try {
        await api.updateServerSettings(s.id, { suppress_role_mentions: value })
      } catch (e) {
        alert((e as Error).message)
      }
    },
    [patchServerSettings],
  )

  const handleLeaveServer = useCallback(
    async (s: Server) => {
      if (!window.confirm(`Покинуть сервер «${s.name}»?`)) return
      try {
        await api.leaveServer(s.id)
        setServers((prev) => prev.filter((x) => x.id !== s.id))
        if (serverId === s.id) {
          setServerId(null)
          setChannelId(null)
        }
      } catch (e) {
        alert('Не удалось покинуть сервер: ' + (e as Error).message)
      }
    },
    [serverId],
  )

  /** Какой канал сейчас создаём — вид или null. Само имя и настройки
   * спрашивает CreateChannelModal (раньше это был window.prompt, который умел
   * спросить только имя, а медленный режим/приватность задать было негде). */
  const [createChannelKind, setCreateChannelKind] = useState<'text' | 'voice' | null>(
    null,
  )
  // В каком разделе нажали «+». Отдельным состоянием рядом с видом канала, а
  // не полем в нём: null здесь означает «вне разделов» — законное значение, а
  // не «модалки нет» (за это отвечает createChannelKind).
  const [createChannelCategoryId, setCreateChannelCategoryId] = useState<number | null>(
    null,
  )

  const handleCreateChannel = (kind: 'text' | 'voice', categoryId: number | null) => {
    setCreateChannelCategoryId(categoryId)
    setCreateChannelKind(kind)
  }

  /** Ошибку наружу не глушим: модалка показывает её у себя и не закрывается,
   * чтобы набранное имя не пропало (см. CreateChannelModal). */
  const handleCreateChannelSubmit = async (
    kind: 'text' | 'voice',
    data: { name: string; slowmodeSeconds: number; isPrivate: boolean },
  ) => {
    if (serverId == null) return
    const ch = await api.createChannel(serverId, data.name, kind, {
      slowmodeSeconds: data.slowmodeSeconds,
      isPrivate: data.isPrivate,
      categoryId: createChannelCategoryId,
    })
    setServers((prev) =>
      prev.map((s) =>
        s.id === serverId ? { ...s, channels: [...s.channels, ch] } : s,
      ),
    )
  }

  /** Контекстное меню раздела и модалка переименования. Как и у остальных
   * меню сайдбара, координаты храним здесь: сам сайдбар их только сообщает. */
  const [categoryContextMenu, setCategoryContextMenu] = useState<{
    id: number
    name: string
    x: number
    y: number
  } | null>(null)
  const [renameCategoryTarget, setRenameCategoryTarget] = useState<{
    id: number
    name: string
  } | null>(null)

  // Обычная функция, а не useCallback: соседние обработчики этого хука
  // объявлены так же, а React Compiler на useCallback вокруг setState с
  // объектным параметром отказывается сохранять мемоизацию (Compilation
  // Skipped) — и падает линтер, у которого это ошибка, а не предупреждение.
  const openCategoryContextMenu = (
    id: number,
    name: string,
    e: { clientX: number; clientY: number },
  ) => {
    setCategoryContextMenu({ id, name, x: e.clientX, y: e.clientY })
  }

  /** Перенести канал в раздел (перетаскиванием в сайдбаре). Состояние
   * обновляем сразу, не дожидаясь эха: канал уезжает под курсором, и
   * задержка в полсекунды выглядит как «не сработало». Ошибку откатываем. */
  const handleMoveChannelToCategory = useCallback(
    (channelId: number, categoryId: number | null) => {
      const apply = (value: number | null) =>
        setServers((prev) =>
          prev.map((s) => ({
            ...s,
            channels: s.channels.map((c) =>
              c.id === channelId ? { ...c, category: value } : c,
            ),
          })),
        )
      const previous =
        serversRef.current
          .flatMap((s) => s.channels)
          .find((c) => c.id === channelId)?.category ?? null
      if (previous === categoryId) return
      apply(categoryId)
      void api.moveChannelToCategory(channelId, categoryId).catch(() => apply(previous))
    },
    [],
  )

  /** Создать раздел. Список серверов перечитывать не нужно — своё состояние
   * правим сразу, остальным прилетит server_categories (см. useGatewayEvents). */
  const handleCreateCategory = useCallback(
    async (name: string) => {
      if (serverId == null) return
      const category = await api.createCategory(serverId, name)
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId ? { ...s, categories: [...s.categories, category] } : s,
        ),
      )
    },
    [serverId],
  )

  const handleRenameCategory = useCallback(
    async (categoryId: number, name: string) => {
      if (serverId == null) return
      const updated = await api.updateCategory(serverId, categoryId, { name })
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? {
                ...s,
                categories: s.categories.map((c) =>
                  c.id === categoryId ? updated : c,
                ),
              }
            : s,
        ),
      )
    },
    [serverId],
  )

  /** Удалить раздел. Каналы внутри не удаляются — становятся «вне разделов»
   * (см. backend, SET_NULL), поэтому чиним у себя и их тоже. */
  const handleDeleteCategory = useCallback(
    async (categoryId: number) => {
      if (serverId == null) return
      await api.deleteCategory(serverId, categoryId)
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? {
                ...s,
                categories: s.categories.filter((c) => c.id !== categoryId),
                channels: s.channels.map((c) =>
                  c.category === categoryId ? { ...c, category: null } : c,
                ),
              }
            : s,
        ),
      )
    },
    [serverId],
  )

  /** Где сейчас заводим ветку — канал и, если ветка растёт из сообщения, оно
   * само (нужно и для message_id, и чтобы предложить название по его тексту).
   * null — модалки нет. Тот же приём, что и createChannelKind выше. */
  const [createThreadTarget, setCreateThreadTarget] = useState<{
    channelId: number
    messageId?: number
    /** Текст исходного сообщения — подставляется в поле названия. */
    suggestedName?: string
  } | null>(null)

  /** Открытая ветка — id, а не channelId: ветка живёт КОЛОНКОЙ СПРАВА, рядом
   * с родительским каналом (как панель модератора, см. ThreadPanel), а не
   * подменяет собой основной чат. Иначе, уйдя в ветку, теряешь из виду
   * разговор, ответвлением от которого она и является — а в Discord их видно
   * одновременно, ради этого ветки и существуют.
   *
   * Держим только id, сам канал резолвим из currentServer при рендере — тот
   * же приём, что у channelContextMenuId выше: ветку могли переименовать или
   * закрыть, пока панель открыта, и снимок разъехался бы с реальностью. */
  const [openThreadId, setOpenThreadId] = useState<number | null>(null)
  const openThread = channels.find((c) => c.id === openThreadId) || null

  /** Открыть ветку в панели. Основной чат при этом переключается на её
   * РОДИТЕЛЯ: панель показывает ответвление, а слева от неё должен быть тот
   * разговор, от которого оно ответвилось. */
  const handleOpenThread = (thread: Channel) => {
    if (thread.parent != null) setChannelId(thread.parent)
    setOpenThreadId(thread.id)
    // Открыли другую ветку — показываем её переписку, а не поиск или
    // закреплённые, оставшиеся от предыдущей: они были про неё, не про эту.
    setThreadPane('messages')
    setUnreadChannelIds((prev) => {
      if (!prev.has(thread.id)) return prev
      const next = new Set(prev)
      next.delete(thread.id)
      return next
    })
  }

  /** Ошибку наружу не глушим — её показывает модалка, не закрываясь, чтобы
   * набранное название не пропало (см. CreateThreadModal и тот же приём у
   * handleCreateChannelSubmit). Готовую ветку сразу открываем: её и создавали
   * ради того, чтобы в ней писать. */
  const handleCreateThreadSubmit = async (name: string, inviteOnly: boolean) => {
    const target = createThreadTarget
    if (!target) return
    const thread = await api.createThread(target.channelId, {
      name,
      messageId: target.messageId,
      inviteOnly,
    })
    setOpenThreadId(thread.id)
    setServers((prev) =>
      prev.map((s) =>
        s.id === thread.server
          ? {
              ...s,
              // Ветка из этого сообщения могла уже существовать — бэкенд тогда
              // возвращает её, а не создаёт вторую (см. api.createThread), и
              // добавлять её в список второй раз незачем.
              channels: s.channels.some((c) => c.id === thread.id)
                ? s.channels.map((c) => (c.id === thread.id ? thread : c))
                : [...s.channels, thread],
            }
          : s,
      ),
    )
  }

  /** Правый клик по ветке — где угодно: по плашке под сообщением, по строке в
   * сайдбаре, по ссылке в системной записи. Держим id и координаты, сам канал
   * резолвим при рендере — тот же приём, что и у channelContextMenuId. */
  const [threadContextMenu, setThreadContextMenu] = useContextMenuState<{
    id: number
    x: number
    y: number
    /** Меню-многоточие в шапке самой панели: у него есть пункты «на весь
     * экран», «поиск» и «закреплённые», которых нет у меню из списка. */
    fromPanel?: boolean
  }>()
  /** Ветка, которую сейчас переименовываем («Редактировать ветку»). */
  const [renameThreadId, setRenameThreadId] = useState<number | null>(null)
  /** Открыт ли список всех веток канала («Показать все ветки»). */
  const [threadListChannelId, setThreadListChannelId] = useState<number | null>(null)
  /** Что сейчас показано в панели ветки вместо ленты — поиск, закреплённые
   * или ничего. Одним состоянием, а не двумя флагами: обе панели занимают
   * одно и то же место, и «открыты обе» — состояние, которого не бывает. */
  const [threadPane, setThreadPane] = useState<'messages' | 'search' | 'pins'>(
    'messages')
  /** Ветка, чей состав участников сейчас смотрим («Участники ветки»). */
  const [threadMembersId, setThreadMembersId] = useState<number | null>(null)

  /** Переименовать ветку. Ошибку наружу не глушим — её показывает модалка,
   * не закрываясь, чтобы набранное имя не пропало. */
  const handleRenameThread = async (thread: Channel, name: string) => {
    applyChannelUpdate(await api.renameChannel(thread.id, name))
  }

  /** Присоединиться к ветке или выйти из неё. Ответ ручки — сама ветка со
   * свежим joined, его и применяем: от него зависит и сайдбар, и подпись
   * пункта меню. */
  const handleToggleThreadJoin = async (thread: Channel) => {
    try {
      applyChannelUpdate(
        thread.joined
          ? await api.leaveThread(thread.id)
          : await api.joinThread(thread.id),
      )
    } catch (e) {
      alert('Не удалось изменить участие в ветке: ' + (e as Error).message)
    }
  }

  const handleSetThreadLocked = async (thread: Channel, locked: boolean) => {
    try {
      applyChannelUpdate(await api.setThreadLocked(thread.id, locked))
    } catch (e) {
      alert('Не удалось изменить блокировку ветки: ' + (e as Error).message)
    }
  }

  /** «Копировать ссылку» — прямая ссылка на ветку, по которой она открывается
   * панелью (см. useInviteLinks: параметр разбирается при загрузке). Не
   * приглашение: приглашают на сервер, а сюда зовут человека, который на
   * сервере уже есть. */
  const handleCopyThreadLink = async (thread: Channel) => {
    const link = `${location.origin}${location.pathname}?thread=${thread.id}`
    try {
      await navigator.clipboard.writeText(link)
    } catch (e) {
      alert('Не удалось скопировать ссылку: ' + (e as Error).message)
    }
  }

  /** Закрыть ветку или вернуть её из архива. Панель при этом не закрывается:
   * закрытая ветка пропадает из сайдбара, но читать её можно как и раньше —
   * шапка просто получает пометку «закрыта» (см. ThreadPanel). */
  const handleSetThreadArchived = async (thread: Channel, archived: boolean) => {
    try {
      applyChannelUpdate(await api.setThreadArchived(thread.id, archived))
    } catch (e) {
      alert('Не удалось изменить состояние ветки: ' + (e as Error).message)
    }
  }

  // Оптимистичный патч my_settings ОДНОГО канала — тот же приём, что и
  // patchServerSettings для сервера целиком, только адресован конкретному
  // каналу внутри своего сервера.
  const patchChannelSettings = useCallback(
    (channelIdValue: number, patch: Partial<ChannelMemberSettings>) => {
      setServers((prev) =>
        prev.map((s) => ({
          ...s,
          channels: s.channels.map((c) =>
            c.id === channelIdValue ? { ...c, my_settings: { ...c.my_settings, ...patch } } : c,
          ),
        })),
      )
    },
    [],
  )

  const handleSetChannelMute = useCallback(
    async (channel: Channel, minutes: number | 'forever' | null) => {
      patchChannelSettings(channel.id, {
        muted: minutes !== null,
        muted_forever: minutes === 'forever',
        muted_until: minutes === 'forever' || minutes === null
          ? null
          : channel.my_settings.muted_until,
      })
      try {
        const updated =
          minutes === null
            ? await api.updateChannelMemberSettings(channel.id, { unmute: true })
            : minutes === 'forever'
              ? await api.updateChannelMemberSettings(channel.id, { mute_forever: true })
              : await api.updateChannelMemberSettings(channel.id, { mute_minutes: minutes })
        patchChannelSettings(channel.id, updated)
      } catch (e) {
        alert('Не удалось изменить заглушение канала: ' + (e as Error).message)
      }
    },
    [patchChannelSettings],
  )

  const handleSetChannelNotificationLevel = useCallback(
    async (channel: Channel, level: ChannelNotifyLevel) => {
      patchChannelSettings(channel.id, { notification_level: level })
      try {
        await api.updateChannelMemberSettings(channel.id, { notification_level: level })
      } catch (e) {
        alert('Не удалось изменить параметры уведомлений канала: ' + (e as Error).message)
      }
    },
    [patchChannelSettings],
  )

  // Закрепить/открепить голосовой канал — личная настройка (Membership.
  // pinned_channel_ids), см. ChannelContextMenu «Закрепить канал вверху».
  const handleTogglePinChannel = async (server: Server, channel: Channel) => {
    const current = server.my_settings.pinned_channel_ids
    const next = current.includes(channel.id)
      ? current.filter((id) => id !== channel.id)
      : [...current, channel.id]
    patchServerSettings(server.id, { pinned_channel_ids: next })
    try {
      await api.updateServerSettings(server.id, { pinned_channel_ids: next })
    } catch (e) {
      patchServerSettings(server.id, { pinned_channel_ids: current })
      alert('Не удалось закрепить канал: ' + (e as Error).message)
    }
  }

  // «Копировать ссылку» — прямое действие без модалки, в отличие от
  // ChannelInviteModal (та тоже умеет копировать ту же ссылку, но открыта
  // ради выбора друга). Ссылка та же самая (get_or_create на бэке — один
  // код на канал), просто более короткий путь.
  const handleCopyChannelLink = async (server: Server, channel: Channel) => {
    try {
      const { code } = await api.serverInviteLink(server.id, channel.id)
      const link = `${location.origin}${location.pathname}?voiceInvite=${code}`
      await navigator.clipboard.writeText(link)
    } catch (e) {
      alert('Не удалось получить ссылку: ' + (e as Error).message)
    }
  }

  /** Общая часть «поправили канал на сервере» — обе ручки ниже отдают уже
   * обновлённый канал, и его надо положить в тот сервер, где он лежит. */
  const applyChannelUpdate = (updated: Channel) =>
    setServers((prev) =>
      prev.map((s) => ({
        ...s,
        channels: s.channels.map((c) => (c.id === updated.id ? updated : c)),
      })),
    )

  const handleSetChannelStatus = async (channel: Channel, status: string) => {
    try {
      applyChannelUpdate(await api.setChannelStatus(channel.id, status))
    } catch (e) {
      alert('Не удалось установить статус канала: ' + (e as Error).message)
    }
  }

  const handleSetChannelSlowmode = async (channel: Channel, seconds: number) => {
    try {
      applyChannelUpdate(await api.setChannelSlowmode(channel.id, seconds))
    } catch (e) {
      alert('Не удалось изменить медленный режим: ' + (e as Error).message)
    }
  }

  const handleSetChannelPrivacy = async (
    channel: Channel,
    isPrivate: boolean,
    allowedRoleIds: number[],
    allowedUserIds: number[],
  ) => {
    try {
      applyChannelUpdate(
        await api.setChannelPrivacy(channel.id, isPrivate, allowedRoleIds, allowedUserIds),
      )
    } catch (e) {
      alert('Не удалось изменить приватность канала: ' + (e as Error).message)
    }
  }

  const handleRenameChannel = async (channel: Channel, name: string) => {
    try {
      applyChannelUpdate(await api.renameChannel(channel.id, name))
    } catch (e) {
      alert('Не удалось переименовать канал: ' + (e as Error).message)
    }
  }

  const handleSetChannelVisibility = async (
    channel: Channel,
    mode: 'default' | 'spoiler' | 'age_restricted',
  ) => {
    try {
      applyChannelUpdate(await api.setChannelVisibility(channel.id, mode))
    } catch (e) {
      alert('Не удалось изменить видимость контента: ' + (e as Error).message)
    }
  }

  /** «Приостановить приглашения» — вкладка «Приглашения» в ChannelSettingsModal.
   * Оптимистично, как и остальные переключатели канала (см. patchChannelSettings
   * рядом, только это не my_settings, а поле самого канала). */
  const handleSetChannelInvitesPaused = async (channel: Channel, paused: boolean) => {
    setServers((prev) =>
      prev.map((s) => ({
        ...s,
        channels: s.channels.map((c) =>
          c.id === channel.id ? { ...c, invites_paused: paused } : c,
        ),
      })),
    )
    try {
      await api.setChannelInvitesPaused(channel.id, paused)
    } catch (e) {
      alert('Не удалось изменить паузу приглашений: ' + (e as Error).message)
    }
  }

  /** Клонировать канал — сам клон приходит и обычным ответом ручки, и следом
   * событием channel_create по WS (см. backend ChannelClone) — на месте
   * применяем только ответ, событие лишь подтвердит то же самое (и не
   * продублирует: channel_create у useGatewayEvents уже идемпотентен по id). */
  const handleCloneChannel = async (channel: Channel) => {
    try {
      const clone = await api.cloneChannel(channel.id)
      setServers((prev) =>
        prev.map((s) =>
          s.id === clone.server ? { ...s, channels: [...s.channels, clone] } : s,
        ),
      )
      return clone
    } catch (e) {
      alert('Не удалось клонировать канал: ' + (e as Error).message)
      return null
    }
  }

  /** Удалить канал — с тем же предупреждением о необратимости и тем же
   * приёмом мгновенного локального применения, что и у handleLeaveServer
   * выше: не ждём WS-эха себе самому, чтобы канал не «висел» в сайдбаре ещё
   * секунду после подтверждения. Остальным участникам его уберёт событие
   * channel_delete (см. useGatewayEvents). */
  const handleDeleteChannel = async (channel: Channel) => {
    if (!window.confirm(
      `Удалить канал «${channel.name}»? Это действие необратимо — вместе с ` +
        'каналом пропадут все его сообщения.',
    )) {
      return
    }
    try {
      await api.deleteChannel(channel.id)
      setServers((prev) =>
        prev.map((s) =>
          s.id === channel.server
            ? { ...s, channels: s.channels.filter((c) => c.id !== channel.id) }
            : s,
        ),
      )
      if (channelId === channel.id) setChannelId(null)
    } catch (e) {
      alert('Не удалось удалить канал: ' + (e as Error).message)
    }
  }

  return {
    servers, setServers,
    serverId, setServerId,
    channelId, setChannelId,
    members, setMembers,
    serverRoles, setServerRoles,
    serverMembersCache, setServerMembersCache,
    fetchedServerDataIds, serversRef,
    unreadChannelIds, setUnreadChannelIds,
    showDiscover, setShowDiscover,
    showServerSettings, setShowServerSettings,
    serverContextMenuServerId, setServerContextMenuServerId,
    showServerInviteId, setShowServerInviteId,
    showServerPrivacyId, setShowServerPrivacyId,
    channelContextMenuId, setChannelContextMenuId,
    showChannelInviteId, setShowChannelInviteId,
    showChannelSettingsId, setShowChannelSettingsId,
    currentServer, channels, currentChannel,
    mutedServerIds, unreadServerIds,
    channelServerId, channelServerIdRef,
    membersForServer, rolesForServer,
    isServerMutedNow, shouldNotifyForChannel, shouldNotifyRef,
    selectServer, reloadMembers, reloadRoles,
    handleCreateServer, handleJoined, handleServerUpdated,
    handleSelectChannel, handleMarkServerRead, handleMarkChannelRead, patchServerSettings,
    handleMuteServer, handleUnmuteServer, handleSetNotificationLevel,
    handleToggleIgnoreAtHere, handleToggleSuppressRoleMentions, handleLeaveServer,
    handleCreateChannel, handleTogglePinChannel, handleCopyChannelLink, handleSetChannelStatus,
    handleMoveChannelToCategory, handleCreateCategory, handleRenameCategory,
    handleDeleteCategory, openCategoryContextMenu,
    categoryContextMenu, setCategoryContextMenu,
    renameCategoryTarget, setRenameCategoryTarget,
    handleSetChannelSlowmode, handleSetChannelPrivacy, handleRenameChannel,
    handleSetChannelVisibility, handleCloneChannel, handleDeleteChannel,
    handleSetChannelMute, handleSetChannelNotificationLevel, handleSetChannelInvitesPaused,
    createChannelKind, setCreateChannelKind, handleCreateChannelSubmit,
    createThreadTarget, setCreateThreadTarget, handleCreateThreadSubmit,
    handleSetThreadArchived,
    openThreadId, openThread, setOpenThreadId, handleOpenThread,
    threadContextMenu, setThreadContextMenu,
    renameThreadId, setRenameThreadId,
    threadListChannelId, setThreadListChannelId,
    threadPane, setThreadPane,
    threadMembersId, setThreadMembersId,
    handleToggleThreadJoin, handleSetThreadLocked, handleCopyThreadLink,
    handleRenameThread,
  }
}
