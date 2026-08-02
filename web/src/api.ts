/** Статус, который выбирает сам пользователь. */
export type UserStatus = 'online' | 'dnd' | 'invisible'
/** Что видят другие: invisible всегда маскируется под offline. */
export type EffectiveStatus = 'online' | 'dnd' | 'offline'
/** Кто может НАЧАТЬ новую личку со мной — не действует на уже идущие диалоги. */
export type DmPrivacy = 'friends' | 'nobody' | 'everyone'

/** Публичный профиль — то, что приходит про ДРУГИХ людей.
 *
 * Тяжёлой гифки-баннера здесь намеренно нет: этот объект вложен в каждое
 * сообщение и в каждую строку ростера, и баннер (до 4 МБ data-URL'ом) уезжал
 * десятки раз за один ответ. Для чужой карточки профиля он догружается
 * отдельно по требованию — api.profileCard(). */
export interface User {
  id: number
  username: string
  /** Необязательная подпись поверх username в карточке профиля — пусто,
   * если не задана (тогда карточка показывает только username, без
   * дублирующей второй строки). См. accounts.models.User.display_name. */
  display_name: string
  avatar_color: string
  /** Картинка аватара (data-URL), пусто — цветной кружок с буквой. У
   * анимированного аватара (см. avatar_animated) здесь лежит ВЫБРАННЫЙ КАДР
   * гифки — то, что видно, пока анимация не играет. */
  avatar_image: string
  /** У аватара есть гифка. Самой гифки тут нет — она тяжёлая, а этот объект
   * едет в каждом сообщении и каждой строке ростера; догружается по
   * требованию, см. avatarAnim.ts. */
  avatar_animated: boolean
  /** Владелец разрешил другим скачивать свой аватар (кнопка в карточке
   * профиля). Не защита — картинка и так в браузере, — а вежливость. */
  avatar_downloadable: boolean
  /** CSS linear-gradient() для фона карточки профиля; пусто — дефолтный градиент. */
  banner_gradient: string
  status: UserStatus
  /** id шрифта ника (см. NameFont ниже) — null, пусто = системный шрифт. */
  name_font: number | null
  name_effect: NameEffect
  /** Хекс-цвета стиля ника — сколько реально используется, зависит от
   * name_effect (см. NAME_EFFECTS в nameStyle.ts). Пусто — обычный цвет
   * текста темы, без переопределения. */
  name_color_1: string
  name_color_2: string
  /** Множитель скорости CSS-анимации для эффектов, у которых она есть
   * (neon/cartoon) — 1 обычная, диапазон 0.5..2.5 (см. DisplayNameStyleModal
   * и accounts.serializers.ProfileUpdateSerializer.validate_name_anim_speed).
   * Для остальных эффектов ни на что не влияет. */
  name_anim_speed: number
}

/** См. accounts.models.User.NAME_EFFECT_CHOICES. */
export type NameEffect = 'standard' | 'gradient' | 'neon' | 'cartoon' | 'highlight'

/** Один шрифт из каталога — GET /api/auth/name-fonts (см.
 * accounts.models.NameFont). Загружается только через админку. */
export interface NameFont {
  id: number
  label: string
  /** URL файла шрифта — подставляется в @font-face (см. useNameFonts). */
  file: string
}

/** Свой профиль (/api/auth/me) — всё, включая личные настройки и баннер. */
export interface Me extends User {
  /** Номер кадра гифки, выбранного статичной картинкой — редактор аватара
   * открывается на нём же (см. GifAvatarModal). */
  avatar_frame: number
  /** Гифка фона карточки профиля (data-URL); если задана — приоритетнее градиента. */
  banner_image: string
  /** Фон ПОД баннером — виден только когда banner_image задан и он с
   * прозрачностью. Пусто — то, что нарисовано под баннером по умолчанию (см. CSS). */
  banner_color: string
  /** "О себе" в карточке профиля — как и bio у ProfileCard ниже, для СВОЕГО
   * профиля приходит сразу (не тяжёлая, в отличие от banner_image это
   * просто текст), догружать отдельно незачем. */
  bio: string
  /** Короткая подпись рядом с username в карточке — пусто, если не задана. */
  pronouns: string
  /** Короткий статус-текст — в нижней панели и в облачке у аватарки в
   * карточке. Пусто — в панели используется обычная подпись статуса,
   * в карточке облачко не рисуется. */
  custom_status: string
  /** Один эмодзи-символ перед текстом статуса в облачке — своё поле, а не
   * префикс внутри custom_status (см. StatusEditModal). */
  custom_status_emoji: string
  /** ISO-дата регистрации — "В числе участников с" в карточке. */
  date_joined: string
  dm_privacy: DmPrivacy
}

/** Тяжёлая часть чужого профиля — грузится, когда открыли карточку. */
export interface ProfileCard {
  id: number
  banner_gradient: string
  banner_image: string
  banner_color: string
  bio: string
  pronouns: string
  custom_status: string
  custom_status_emoji: string
  date_joined: string
}

/** Приватная заметка о другом пользователе — своя у каждого
 * просматривающего, видна только автору. См. backend chat.models.ProfileNote. */
export interface UserNote {
  text: string
}

/** Один активный сеанс (устройство/браузер) — «Активные сеансы» в
 * настройках, см. backend accounts.models.LoginSession. */
export interface Session {
  id: number
  ip_address: string | null
  user_agent: string
  created_at: string
  last_seen_at: string
  /** Тот самый сеанс, чьим токеном сейчас авторизован этот клиент. */
  is_current: boolean
}

/** Вход по QR — см. backend accounts.models.QRLoginRequest. */
export type QRStatus = 'pending' | 'scanned' | 'confirmed' | 'denied' | 'expired'

export interface QRStatusResponse {
  status: QRStatus
  /** Есть только при status='scanned' — тот самый код, что нужно выбрать на телефоне. */
  code?: string
  /** Есть только при status='confirmed', и только один раз — сервер тут же
   * забывает запрос (см. accounts.views.QRStatusView). */
  access?: string
  refresh?: string
  user?: Me
}

export interface QRScanResponse {
  candidates: string[]
  device: { ip_address: string | null; user_agent: string }
}

export interface Channel {
  id: number
  server: number
  name: string
  kind: 'text' | 'voice'
  position: number
  /** Момент начала текущего разговора (unix-секунды), null если пусто. Только voice. */
  call_started_at: number | null
  /** Статус звонка, который видят все; null если пусто. Только voice. */
  topic: string | null
  /** Персистентный статус канала (правый клик → «Установить статус канала»),
   * в отличие от эфемерного topic выше — переживает опустение канала. */
  status: string
}

/** Права роли на сервере — 1:1 с булевыми полями chat.models.Role
 * (список и порядок для UI — chat/roles.py PERMISSION_FIELDS). */
// manage_invites / manage_nicknames / mention_everyone отсюда убраны: они
// охраняли фичи, которых в проекте нет (модели Invite, никнеймов на сервере
// и разбора @all/@online/@here не существует), и были переключателями,
// которые не делали ничего. Колонки в БД остались — вернутся сюда вместе с
// самими фичами (см. chat/roles.py RESERVED_PERMISSION_FIELDS).
export type ServerPermission =
  | 'view_channels'
  | 'manage_channels'
  | 'manage_roles'
  | 'manage_server'
  | 'manage_members'
  | 'create_expressions'
  | 'send_messages'
  | 'delete_messages'
  | 'use_external_emoji'
  | 'speak'
  | 'video'

export type ServerPermissions = Record<ServerPermission, boolean>

/** Кто может пинговать роль (@ИмяРоли) — см. backend chat.models.Role. Не
 * путать с manage_roles (управление самой ролью): это про то, чьё
 * "@ИмяРоли" в тексте вообще СЧИТАЕТСЯ упоминанием участников роли, а не
 * просто текстом (см. web/src/mentions.ts). */
export type MentionPermission = 'everyone' | 'roles'

export interface Role extends ServerPermissions {
  id: number
  name: string
  color: string
  position: number
  /** Роль «для всех» (аналог @everyone) — её нельзя удалить и не нужно выдавать. */
  is_default: boolean
  /** Роль-зеркало прав владельца сервера — редактирует только он сам (см.
   * backend chat.roles.owner_permissions), никому не выдаётся, удалить нельзя. */
  is_owner_role: boolean
  mention_permission: MentionPermission
  /** id ролей, чьи участники вправе пинговать ЭТУ роль — используется только
   * при mention_permission='roles'. */
  mentionable_by: number[]
}

/** Как попасть на сервер — вкладка «Доступ» редактора. */
export type ServerAccessMode = 'invite' | 'request' | 'public'

export interface ServerRule {
  title: string
  text: string
}

/** Ежемесячный/личный уровень уведомлений — как в Discord: все сообщения,
 * только те, где меня упомянули, или ничего. */
export type NotificationLevel = 'all' | 'mentions' | 'none'

/** Личные настройки уведомлений/заглушения/приватности для ОДНОГО сервера —
 * приезжают вместе со списком серверов (Server.my_settings), см. backend
 * chat.serializers.membership_settings_payload. */
export interface ServerMemberSettings {
  notification_level: NotificationLevel
  /** Заглушено ПРЯМО СЕЙЧАС — уже учитывает muted_until относительно
   * времени ответа сервера; клиент досчитывает угасание таймером сам
   * (см. AppShell useMutedState). */
  muted: boolean
  muted_until: string | null
  muted_forever: boolean
  /** Не поднимать уведомление на буквальные "@all"/"@here". */
  ignore_at_here: boolean
  /** Не поднимать уведомление на упоминание ролей, которые у меня есть. */
  suppress_role_mentions: boolean
  /** Разрешить ЛС от других участников этого сервера (доп. к глобальному
   * accounts.dm_privacy — см. backend chat.permissions.can_dm). */
  allow_dms_from_server: boolean
  /** Id закреплённых каналов этого сервера, лично для меня — see
   * ChannelContextMenu «Закрепить канал вверху». Порядок = порядок закрепления. */
  pinned_channel_ids: number[]
}

/** Предпросмотр ссылки-приглашения в конкретный голосовой канал — БЕЗ
 * вступления на сервер (см. backend chat.views.InvitePreview). Показывается
 * в модалке подтверждения перед тем, как реально дёрнуть redeemServerInvite. */
export interface InvitePreview {
  server: { id: number; name: string; icon: string }
  channel: { id: number; name: string }
  already_member: boolean
  participant_count: number
}

export interface Server {
  id: number
  name: string
  owner: number
  created_at: string
  channels: Channel[]
  /** Значок сервера (data-URL, до 512×512); пусто — инициалы в ServerRail. */
  icon: string
  banner_gradient: string
  banner_image: string
  description: string
  /** «Особенности» — короткие теги для поиска серверов и подсказки. */
  tags: string[]
  /** Приватный: описание/особенности видят только участники. */
  is_private: boolean
  access_mode: ServerAccessMode
  age_restricted: boolean
  rules: ServerRule[]
  /** Мои права на этом сервере — по ним прячутся кнопки редактора. */
  my_permissions: ServerPermissions
  /** Мои личные настройки уведомлений на этом сервере. */
  my_settings: ServerMemberSettings
  member_count: number
}

export type ServerInviteStatus = 'pending' | 'accepted' | 'declined'

/** Личное приглашение на сервер — то, что видит ПРИГЛАШЁННЫЙ (см. api.myServerInvites). */
export interface ServerInviteEntry {
  id: number
  server: { id: number; name: string; icon: string }
  /** Есть, только если приглашение — в конкретный голосовой канал (см.
   * ChannelInviteModal), а не на сервер целиком. */
  channel: { id: number; name: string } | null
  created_by: User
  created_at: string
  status: ServerInviteStatus
}

/** Одна пригласительная ссылка участника — строка модераторского списка
 * (см. api.serverInviteLinks, GET /api/servers/<id>/invite-links). */
export interface ServerInviteLinkEntry {
  id: number
  code: string
  channel: { id: number; name: string } | null
  created_by: User
  /** Сколько людей реально вступило по этой ссылке. */
  uses: number
  created_at: string
}

/** Приглашение, встроенное карточкой в сообщение диалога (см.
 * ChatMessageBase.server_invite) — вместо отдельной вкладки «Приглашения»
 * на домашнем экране (см. HomeSidebar/ServerInviteCard). */
export interface ConversationServerInvite {
  id: number
  status: ServerInviteStatus
  server: { id: number; name: string; icon: string; member_count: number }
  channel: { id: number; name: string } | null
}

export interface ServerJoinRequestEntry {
  id: number
  user: User
  message: string
  created_at: string
}

export interface ServerBanEntry {
  id: number
  user: User
  banned_by: User | null
  reason: string
  created_at: string
}

/** Файл, прикреплённый к сообщению (backend chat.models.Attachment). */
export interface Attachment {
  id: string
  /** Путь от корня (`/media/...`) — домен подставляет mediaUrl(). */
  url: string
  original_name: string
  /** Определён сервером ПО СОДЕРЖИМОМУ, а не по заголовку запроса; всё, что
   * небезопасно встраивать, приезжает как application/octet-stream —
   * см. backend chat/uploads.py. Решение «инлайнить или дать скачать»
   * принимается по нему и только по нему. */
  content_type: string
  size: number
  /** Только у картинок — чтобы зарезервировать место под превью. */
  width: number | null
  height: number | null
}

/** Кастомный эмодзи сервера (backend chat.models.ServerEmoji).
 *
 * Два URL, а не один: static_url — то, что показывается ВСЕГДА, а url
 * подставляется только на время наведения/нажатия. У статичного эмодзи они
 * совпадают, чтобы у отрисовки был один вход — см. CustomEmojiImage. */
export interface CustomEmoji {
  id: number
  /** Латиница/цифры/«_», 2..32 — то, что стоит между двоеточиями в токене. */
  name: string
  server: number
  server_name: string
  /** Анимированный файл целиком (`/media/...`) — домен подставляет mediaUrl(). */
  url: string
  /** Первый кадр анимированного; у статичного — тот же файл, что и url. */
  static_url: string
  animated: boolean
  /** Вес файла в байтах — показывается в управлении эмодзи сервера. */
  size: number
  created_by: number | null
  created_at: string
}

/** Одна реакция-эмодзи в агрегированном виде.
 *
 * Сервер не присылает готовый флаг «моя»: один и тот же объект уходит всем
 * получателям разом (см. backend chat/serializers.py reactions_payload).
 * Клиент считает его сам — сверяя user_ids со своим id. */
export interface MessageReaction {
  /** Unicode-символ либо ключ вида "custom:<id>" — см. web/src/emoji.ts. */
  emoji: string
  count: number
  user_ids: number[]
}

export interface ChatMessageReplyBase {
  id: number
  author: User
  content: string
}

/** Общая форма сообщения — и серверного (Message), и личного/группового
 * (ConversationMessage). MessageList/MessageInput работают только с этими
 * полями и не знают, откуда сообщение (см. web/src/components/MessageList.tsx,
 * MessageInput.tsx) — общий базовый тип позволяет переиспользовать оба
 * компонента для диалогов без дублирования. */
export interface ChatMessageBase {
  id: number
  author: User
  content: string
  reply_to: ChatMessageReplyBase | null
  attachments: Attachment[]
  reactions: MessageReaction[]
  /** Только у ConversationMessage — приглашение на сервер, пришедшее
   * карточкой в переписку (см. ConversationServerInvite). У серверных
   * сообщений (Message) всегда undefined. */
  server_invite?: ConversationServerInvite | null
  created_at: string
  edited_at: string | null
  /** Закреплено в канале (см. api.channelPins). Только у сообщений сервера —
   * в личке/группе закреплений нет. */
  pinned?: boolean
}

export interface Message extends ChatMessageBase {
  channel: number
}

export interface Member extends Omit<User, 'status' | 'dm_privacy'> {
  online: boolean
  voice_channel: string | null
  status: EffectiveStatus
  /** Персонально выданные роли (без роли по умолчанию — она у всех). */
  role_ids: number[]
  is_owner: boolean
  /** Статус микрофона/наушников — виден всем, даже не подключённым к каналу. */
  muted: boolean
  deafened: boolean
  /** Демонстрирует ли сейчас экран — тоже видно всем, не только в канале. */
  sharing_screen: boolean
}

/** Минимум, нужный автокомплиту @упоминаний (MessageInput) и рендеру
 * @упоминаний в тексте сообщения (MessageList) — и Member (ростер сервера),
 * и User (участники диалога/группы) ему удовлетворяют без адаптации. */
export interface MentionCandidate {
  id: number
  username: string
  avatar_color: string
  avatar_image: string
  /** Стиль ника (см. nameStyle.ts) — клик по @упоминанию открывает
   * MiniProfilePopup, тому нужен полный ProfilePopupUser. */
  name_font: number | null
  name_effect: NameEffect
  name_color_1: string
  name_color_2: string
  name_anim_speed: number
}

export interface DiscoverServer {
  id: number
  name: string
  icon: string
  member_count: number
  is_member: boolean
  /** У приватного сервера description/tags приходят пустыми, пока не вступишь. */
  is_private: boolean
  access_mode: ServerAccessMode
  age_restricted: boolean
  /** Заявка на вступление уже отправлена и ждёт одобрения. */
  request_pending: boolean
  description: string
  tags: string[]
}

export interface FriendRequestEntry {
  id: number
  user: User
}

export interface FriendsState {
  friends: User[]
  incoming: FriendRequestEntry[]
  outgoing: FriendRequestEntry[]
}

/** Человек для пикера «новый диалог/группа» — друзья + те, с кем есть общий сервер. */
export interface KnownPerson extends User {
  is_friend: boolean
}

export type ConversationKind = 'dm' | 'group'

export interface ConversationLastMessage {
  content: string
  author_id: number
  created_at: string
}

export interface Conversation {
  id: number
  kind: ConversationKind
  /** Только для group; пусто — фронт сам собирает заголовок из участников. */
  name: string
  created_at: string
  /** Без меня самого. */
  participants: User[]
  last_message: ConversationLastMessage | null
  call_started_at: number | null
  /** Закреплена вверху списка «Диалоги» — личное, у собеседника своё
   * (см. backend chat.models.ConversationParticipant.pinned). */
  pinned: boolean
}

/** Личное отношение к другому пользователю — игнор и блокировка, обе
 * односторонние и невзаимные (см. backend chat.models.UserRelationState). */
export interface UserRelation {
  /** Не поднимать уведомления от него (сообщения при этом видны). */
  ignored: boolean
  /** Скрыть его сообщения и запретить ему начинать со мной личку. */
  blocked: boolean
}

export interface ConversationMessage extends ChatMessageBase {
  conversation: number
}

// Пусто => same-origin (относительные запросы). Для dev задаётся в web/.env.
const API: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

let accessToken: string | null = localStorage.getItem('access')
// Раньше refresh-токен приходил с логина и молча выбрасывался: механизма
// обновления сессии не существовало вовсе, так что время жизни сессии было
// равно времени жизни access-токена, а по его истечении все запросы начинали
// падать без единого объяснения.
let refreshToken: string | null = localStorage.getItem('refresh')

export function setTokens(access: string | null, refresh: string | null) {
  accessToken = access
  if (access) localStorage.setItem('access', access)
  else localStorage.removeItem('access')
  refreshToken = refresh
  if (refresh) localStorage.setItem('refresh', refresh)
  else localStorage.removeItem('refresh')
}

export function getToken(): string | null {
  return accessToken
}

export function getRefreshToken(): string | null {
  return refreshToken
}

/** Ошибка запроса с HTTP-статусом.
 *
 * Раньше req() кидал голый Error с текстом от сервера, и вызывающий не мог
 * отличить «сервер сказал 401» от «сети нет вовсе». Из-за этого, например,
 * старт приложения при недоступном бэкенде (перезапуск/деплой/спящий
 * ноутбук) выглядел как протухшая сессия и МОЛЧА выкидывал из аккаунта —
 * один из источников «иногда выбивает, причина не ясна». Статус 0 = запрос
 * вообще не долетел. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function storedItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// Синхронизация вкладок. Токены лежат в localStorage (общем на все вкладки),
// но в памяти каждая вкладка держит СВОЮ копию. С ротацией refresh-токенов
// (SIMPLE_JWT.ROTATE_REFRESH_TOKENS + блэклист старого) это давало гонку:
// вкладка A обновляется, вкладка B продолжает считать своим уже отозванный
// refresh — и на первом же истёкшем access-токене получает отказ и выкидывает
// пользователя, хотя живая сессия есть, просто в соседней вкладке. Событие
// storage приходит только в ДРУГИЕ вкладки — ровно то, что нужно.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'access') {
      accessToken = e.newValue
      // Вышли из аккаунта в другой вкладке — выходим и здесь, иначе эта
      // вкладка осталась бы с нарисованным, но нерабочим аккаунтом.
      if (e.newValue === null) onSessionExpired?.()
    } else if (e.key === 'refresh') {
      refreshToken = e.newValue
    }
  })
}

/** Колбэк «сессия окончательно умерла» — ставит auth.tsx, чтобы разлогинить
 * UI. Без него истёкший токен приводил к тому, что все экраны молча
 * схлопывались в пустое состояние: серверов нет, сообщений нет, друзей нет,
 * а причина не показана нигде. */
let onSessionExpired: (() => void) | null = null

export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn
}

// Один общий промис на все параллельные 401. Иначе десяток одновременных
// запросов запустил бы десяток refresh'ей, а с ротацией токенов на сервере
// (SIMPLE_JWT.ROTATE_REFRESH_TOKENS) выжил бы ровно один — остальные
// получили бы отказ и выкинули пользователя на логин без причины.
let refreshInFlight: Promise<RefreshResult> | null = null

/** Чем кончилась попытка обновить сессию.
 *
 * Три исхода, а не «токен или null»: «не смогли» — это ЛИБО отказ сервера по
 * токену (сессия действительно кончилась, надо на экран входа), ЛИБО
 * недоступный сервер/сеть (бэкенд перезапускают, вайфай моргнул). Раньше оба
 * приводили к одному и тому же setTokens(null, null) — и второй случай
 * выкидывал из аккаунта на ровном месте. */
type RefreshResult =
  | { status: 'refreshed'; access: string }
  | { status: 'unauthorized' }
  | { status: 'unavailable' }

async function requestRefresh(refresh: string): Promise<RefreshResult> {
  let res: Response
  try {
    res = await fetch(`${API}/api/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ refresh }),
    })
  } catch {
    // Сеть не дала даже дойти до сервера — сессия тут ни при чём.
    return { status: 'unavailable' }
  }
  // 5xx/429 — проблема сервера, а не токена: сохраняем сессию и дадим
  // повторить позже.
  if (res.status >= 500 || res.status === 429) return { status: 'unavailable' }
  if (!res.ok) return { status: 'unauthorized' }
  let data: { access?: string; refresh?: string }
  try {
    data = await res.json()
  } catch {
    return { status: 'unavailable' }
  }
  if (!data.access) return { status: 'unavailable' }
  // ROTATE_REFRESH_TOKENS=True — сервер отдаёт заодно новый refresh, а
  // старый отправляет в блэклист. Не сохранить его = разлогиниться на
  // следующем же обновлении.
  setTokens(data.access, data.refresh ?? refresh)
  return { status: 'refreshed', access: data.access }
}

function refreshAccessToken(): Promise<RefreshResult> {
  // Хранилище общее на все вкладки, а память — своя (см. слушатель storage
  // выше). Вкладка могла проспать событие (браузер троттлит фоновые), поэтому
  // перед обновлением явно сверяемся с тем, что реально лежит в localStorage:
  // обновляться заведомо устаревшим токеном = гарантированный отказ.
  const stored = storedItem('refresh')
  if (stored && stored !== refreshToken) refreshToken = stored
  if (!refreshToken) return Promise.resolve<RefreshResult>({ status: 'unauthorized' })
  if (!refreshInFlight) {
    // Захватываем токен, с которым стартовали: если за время фетча кто-то
    // переключил аккаунт (см. auth.tsx switchAccount) или вышел, module-level
    // refreshToken уже указывает на другой аккаунт/пуст — применять к нему
    // результат ЭТОГО, более старого, обновления нельзя, иначе токены только
    // что переключённого аккаунта тихо затрутся токенами предыдущего.
    const startedWith = refreshToken
    refreshInFlight = (async (): Promise<RefreshResult> => {
      try {
        const result = await requestRefresh(startedWith)
        if (refreshToken !== startedWith && result.status !== 'refreshed') {
          // Пока обновлялись, аккаунт переключили/вошли заново — отказ
          // касается уже неактуального токена. Живой access при этом есть,
          // и вызывающему надо просто повторить запрос с ним, а не
          // разлогиниваться.
          return accessToken
            ? { status: 'refreshed', access: accessToken }
            : { status: 'unauthorized' }
        }
        if (result.status === 'unauthorized') {
          // Ровно один повтор — на случай, когда наш refresh отозвала не
          // «настоящая» смерть сессии, а ротация в соседней вкладке: она уже
          // положила в хранилище рабочий токен, пока мы ходили со старым.
          const latest = storedItem('refresh')
          if (latest && latest !== startedWith) {
            refreshToken = latest
            return await requestRefresh(latest)
          }
        }
        return result
      } finally {
        refreshInFlight = null
      }
    })()
  }
  return refreshInFlight
}

/** Срок жизни access-токена (unix-секунды) из его же payload, без похода на
 * сервер. Подпись не проверяем — токен наш собственный, из localStorage, и
 * нужен только момент истечения. */
function accessTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/** Заведомо живой access-токен — обновляет заранее, если старый вот-вот
 * истечёт (или уже истёк).
 *
 * Нужен там, где токен предъявляется НЕ обычным запросом и повторить с 401
 * нельзя: WebSocket-подключение к gateway (см. gateway.tsx) и SFU. Без этого
 * вкладка, проспавшая дольше времени жизни access-токена (15 минут, см.
 * settings.SIMPLE_JWT), бесконечно переподключалась заведомо протухшим
 * токеном — realtime молча не возвращался, пока что-нибудь не сходит по HTTP.
 * Возвращает null, только если сессии действительно нет. */
export async function ensureAccessToken(): Promise<string | null> {
  const stored = storedItem('access')
  if (stored && stored !== accessToken) accessToken = stored
  if (!accessToken) return null
  const exp = accessTokenExpiry(accessToken)
  // 30 секунд запаса: за это время успеет пройти сам апгрейд соединения.
  if (exp !== null && exp * 1000 - Date.now() > 30_000) return accessToken
  const refreshed = await refreshAccessToken()
  if (refreshed.status === 'refreshed') return refreshed.access
  if (refreshed.status === 'unauthorized') {
    setTokens(null, null)
    onSessionExpired?.()
    return null
  }
  // Сервер недоступен — отдаём что есть, пусть попытка провалится сама и
  // сработает обычный реконнект: сессию из-за этого рвать нельзя.
  return accessToken
}

async function req(path: string, options: RequestInit = {}, allowRetry = true): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  // include: логин/регистрация заодно ставят Django-сессию (см. LoginView) —
  // в деве Vite (:5173) и API (:8000) разные origin'ы, без явного include
  // браузер cookie не сохранит/не пришлёт.
  let res: Response
  try {
    res = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' })
  } catch {
    // Сеть/сервер недоступны. Статус 0 отличает это от любого ответа сервера —
    // вызывающий (см. auth.tsx) не должен принять это за конец сессии.
    throw new ApiError('Сервер недоступен — проверьте соединение.', 0)
  }

  // 401 больше не сваливается в общую кучу ошибок: сначала пробуем обновить
  // токен и повторить запрос ровно один раз, и только если сервер отказал
  // именно по токену — честно сообщаем, что сессия кончилась.
  if (res.status === 401 && allowRetry && accessToken) {
    const refreshed = await refreshAccessToken()
    if (refreshed.status === 'refreshed') return req(path, options, false)
    if (refreshed.status === 'unavailable') {
      // Обновиться не удалось из-за сети/сервера — токены не трогаем,
      // сессия жива, запрос просто не состоялся.
      throw new ApiError('Сервер недоступен — попробуйте ещё раз.', 0)
    }
    setTokens(null, null)
    onSessionExpired?.()
    throw new ApiError('Сессия истекла — войдите заново.', 401)
  }

  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = await res.json()
      // DRF отдаёт либо {"detail": "..."}, либо по-полевые ошибки валидации
      // {"поле": ["сообщение", ...], ...} — независимо от имени поля берём
      // первое сообщение первого поля, не полагаясь на конкретные названия
      // (username/password/current_password/avatar_image/...).
      const firstFieldError = Object.values(j).find(
        (v): v is string[] => Array.isArray(v) && typeof v[0] === 'string',
      )?.[0]
      detail = j.detail || firstFieldError || JSON.stringify(j)
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status)
  }
  if (res.status === 204) return null
  return res.json()
}

function buildQuery(params: Record<string, number | string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return ''
  return (
    '?' +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
  )
}

/** Абсолютный адрес файла из /media/.
 *
 * Backend отдаёт путь от корня, без домена (см. AttachmentSerializer.get_url):
 * тот же объект сообщения уходит и по WebSocket, где request'а нет. В проде
 * всё за одним доменом и подставлять нечего, а в деве фронт живёт на :5173, и
 * без этой склейки `/media/...` резолвился бы в Vite, а не в Django. */
export function mediaUrl(path: string): string {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return `${API}${path}`
}

interface UploadOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** POST multipart-формы. XHR, а не fetch, ради upload.onprogress: файл до
 * 25 МБ на медленном канале идёт секунды, и полоса прогресса здесь не
 * украшение — без неё непонятно, висит загрузка или нет.
 *
 * onProgress получает долю 0..1. Обновление протухшего токена и повтор — тот
 * же путь, что у обычных запросов (см. req), просто вручную: fetch-обёртка
 * сюда не годится именно из-за прогресса. */
function postForm<T>(path: string, form: FormData, opts: UploadOptions = {}): Promise<T> {
  const send = (token: string | null, allowRetry: boolean): Promise<T> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API}${path}`)
      xhr.withCredentials = true
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        if (xhr.status === 201) {
          try {
            resolve(JSON.parse(xhr.responseText))
          } catch {
            reject(new Error('Некорректный ответ сервера.'))
          }
          return
        }
        // Тот же путь, что у обычных запросов (см. req): протухший токен
        // обновляем и повторяем ровно один раз.
        if (xhr.status === 401 && allowRetry && token) {
          refreshAccessToken().then((refreshed) => {
            if (refreshed.status === 'refreshed') {
              send(refreshed.access, false).then(resolve, reject)
              return
            }
            if (refreshed.status === 'unavailable') {
              reject(new ApiError('Сервер недоступен — попробуйте ещё раз.', 0))
              return
            }
            setTokens(null, null)
            onSessionExpired?.()
            reject(new ApiError('Сессия истекла — войдите заново.', 401))
          })
          return
        }
        let detail = xhr.statusText || 'Не удалось загрузить файл.'
        try {
          detail = JSON.parse(xhr.responseText).detail || detail
        } catch {
          /* ignore */
        }
        reject(new Error(detail))
      }
      xhr.onerror = () => reject(new Error('Сеть недоступна — файл не загрузился.'))
      xhr.onabort = () => reject(new DOMException('Загрузка отменена', 'AbortError'))
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(form)
    })

  if (opts.signal?.aborted) {
    return Promise.reject(new DOMException('Загрузка отменена', 'AbortError'))
  }
  return send(accessToken, true)
}

/** Загрузка вложения. Возвращённый объект — уже сохранённое вложение;
 * привязывается к сообщению позже, при отправке (см. outbox.ts). */
export function uploadAttachment(file: File, opts: UploadOptions = {}): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  return postForm<Attachment>('/api/attachments', form, opts)
}

/** Загрузка кастомного эмодзи на сервер (нужно право create_expressions).
 *
 * static — первый кадр анимированного эмодзи, вырезанный КЛИЕНТОМ (см.
 * gif.ts): именно он показывается, пока на эмодзи не навели. Необязателен —
 * без него бэкенд сохранит эмодзи, просто анимация будет играть всегда. */
export function uploadEmoji(
  serverId: number,
  name: string,
  file: Blob,
  staticFrame?: Blob | null,
  opts: UploadOptions = {},
): Promise<CustomEmoji> {
  const form = new FormData()
  form.append('name', name)
  form.append('file', file, `${name}.${blobExt(file)}`)
  if (staticFrame) form.append('static', staticFrame, `${name}-static.png`)
  return postForm<CustomEmoji>(`/api/servers/${serverId}/emoji`, form, opts)
}

/** Расширение по MIME — только для имени файла: настоящий тип бэкенд всё
 * равно определяет по содержимому (см. backend chat/uploads.py sniff_emoji). */
function blobExt(blob: Blob): string {
  if (blob.type === 'image/gif') return 'gif'
  if (blob.type === 'image/webp') return 'webp'
  return 'png'
}

export const api = {
  register: (username: string, password: string) =>
    req('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string): Promise<{ access: string; refresh: string }> =>
    // allowRetry=false: 401 здесь означает «неверный логин/пароль», а вовсе
    // не протухший токен — обновлять нечего, и попытка refresh'а только
    // подменила бы понятную ошибку на «сессия истекла».
    req(
      '/api/auth/token',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      false,
    ),
  // refresh отдаём серверу, чтобы он положил его в блэклист — иначе «выход»
  // не отзывал ничего и токен жил ещё неделю.
  logout: () =>
    req('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh: getRefreshToken() }),
    }),
  me: (): Promise<Me> => req('/api/auth/me'),
  updateProfile: (data: {
    username?: string
    /** Обязателен, если меняется username — см. backend
     * ProfileUpdateSerializer.validate. */
    current_password?: string
    display_name?: string
    bio?: string
    pronouns?: string
    custom_status?: string
    custom_status_emoji?: string
    avatar_image?: string
    /** Гифка аватара целиком (data-URL). Пустая строка убирает анимацию,
     * оставляя статичный avatar_image. Передавать avatar_image БЕЗ
     * avatar_anim значит «новый обычный аватар» — сервер тогда сам сбрасывает
     * анимацию от прежнего (см. ProfileUpdateSerializer.update). */
    avatar_anim?: string
    /** Номер кадра гифки, выбранного статичной картинкой. */
    avatar_frame?: number
    avatar_downloadable?: boolean
    banner_gradient?: string
    banner_image?: string
    banner_color?: string
    dm_privacy?: DmPrivacy
    name_font?: number | null
    name_effect?: NameEffect
    name_color_1?: string
    name_color_2?: string
    name_anim_speed?: number
  }): Promise<Me> => req('/api/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
  profileCard: (userId: number): Promise<ProfileCard> =>
    req(`/api/users/${userId}/profile-card`),
  /** Гифка анимированного аватара — отдельно и по требованию (в обычном
   * профиле только флаг avatar_animated). Ходить сюда напрямую обычно не
   * нужно: есть кэширующая обёртка, см. avatarAnim.ts. */
  avatarAnimation: (
    userId: number,
  ): Promise<{ avatar_anim: string; downloadable: boolean }> =>
    req(`/api/users/${userId}/avatar-anim`),
  nameFonts: (): Promise<NameFont[]> => req('/api/auth/name-fonts'),
  getUserNote: (userId: number): Promise<UserNote> =>
    req(`/api/users/${userId}/note`),
  setUserNote: (userId: number, text: string): Promise<UserNote> =>
    req(`/api/users/${userId}/note`, { method: 'PUT', body: JSON.stringify({ text }) }),
  changePassword: (current_password: string, new_password: string) =>
    req('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
  /** Переключиться на другой аккаунт, уже авторизованный на этом устройстве
   * (см. accounts.ts) — принимает ЕГО refresh, получает свежую JWT-пару и
   * профиль; сервер заодно переставляет Django-сессию (см. backend
   * SwitchAccountView). */
  switchAccount: (refresh: string): Promise<{ access: string; refresh: string; user: Me }> =>
    req('/api/auth/switch', { method: 'POST', body: JSON.stringify({ refresh }) }),
  getSessions: (): Promise<Session[]> => req('/api/auth/sessions'),
  /** Отозвать ОДИН чужой сеанс — крестик у "других устройств" в настройках.
   * Текущий сеанс так не отозвать (сервер отдаст 400 — для него есть
   * обычный выход). */
  revokeSession: (id: number) => req(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  /** «Выйти на всех известных устройствах» — не меняет пароль, только
   * отзывает refresh-токены всех сеансов, включая текущий. */
  revokeAllSessions: () => req('/api/auth/sessions/revoke-all', { method: 'POST' }),

  // --- вход по QR-коду -----------------------------------------------------
  /** Экран логина на ПК — без авторизации, ПК ещё не залогинен. */
  qrStart: (): Promise<{ token: string; expires_in: number }> =>
    req('/api/auth/qr/start', { method: 'POST' }),
  /** Поллинг с ПК тем же token'ом — тоже без авторизации. */
  qrStatus: (token: string): Promise<QRStatusResponse> => req(`/api/auth/qr/${token}/status`),
  /** Телефон (уже залогинен) сканирует QR. */
  qrScan: (token: string): Promise<QRScanResponse> =>
    req(`/api/auth/qr/${token}/scan`, { method: 'POST' }),
  /** Телефон подтверждает код, который видит на экране ПК. */
  qrConfirm: (token: string, code: string) =>
    req(`/api/auth/qr/${token}/confirm`, { method: 'POST', body: JSON.stringify({ code }) }),

  config: () => req('/api/config'),

  servers: (): Promise<Server[]> => req('/api/servers'),
  createServer: (name: string): Promise<Server> =>
    req('/api/servers', { method: 'POST', body: JSON.stringify({ name }) }),
  /** Поиск серверов. Приватные сюда не попадают вообще — кроме тех, где мы
   * уже состоим (см. backend chat.views.ServerDiscover). */
  discover: (query = ''): Promise<DiscoverServer[]> =>
    req(`/api/servers/discover${buildQuery({ q: query.trim() })}`),
  /** Сервер «по заявке» вместо вступления отдаёт {status:'pending'} —
   * членства ещё нет, ждём одобрения (см. chat.views.ServerJoin). */
  joinServer: (id: number): Promise<Server | { status: 'pending'; detail: string }> =>
    req(`/api/servers/${id}/join`, { method: 'POST' }),
  members: (serverId: number): Promise<Member[]> =>
    req(`/api/servers/${serverId}/members`),

  // --- редактор сервера ---------------------------------------------------
  updateServer: (
    id: number,
    data: Partial<{
      name: string
      icon: string
      banner_gradient: string
      banner_image: string
      description: string
      tags: string[]
      is_private: boolean
      access_mode: ServerAccessMode
      age_restricted: boolean
      rules: ServerRule[]
    }>,
  ): Promise<Server> =>
    req(`/api/servers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  roles: (serverId: number): Promise<Role[]> => req(`/api/servers/${serverId}/roles`),
  createRole: (serverId: number, data: Partial<Role>): Promise<Role> =>
    req(`/api/servers/${serverId}/roles`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateRole: (serverId: number, roleId: number, data: Partial<Role>): Promise<Role> =>
    req(`/api/servers/${serverId}/roles/${roleId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteRole: (serverId: number, roleId: number) =>
    req(`/api/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' }),

  // --- кастомные эмодзи ---------------------------------------------------
  /** Все эмодзи всех моих серверов разом — из этого строится и лента наборов
   * в пикере, и отрисовка токенов в уже пришедших сообщениях. Ходить сюда
   * напрямую не нужно: есть кэш с подпиской, см. customEmoji.ts. */
  myEmoji: (): Promise<CustomEmoji[]> => req('/api/emoji'),
  /** Метаданные конкретных эмодзи, в том числе с серверов, где меня нет —
   * иначе присланный в личку чужой эмодзи остался бы квадратом-заглушкой. */
  resolveEmoji: (ids: number[]): Promise<CustomEmoji[]> =>
    req(`/api/emoji?ids=${ids.join(',')}`),
  serverEmoji: (serverId: number): Promise<CustomEmoji[]> =>
    req(`/api/servers/${serverId}/emoji`),
  renameEmoji: (serverId: number, emojiId: number, name: string): Promise<CustomEmoji> =>
    req(`/api/servers/${serverId}/emoji/${emojiId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteEmoji: (serverId: number, emojiId: number) =>
    req(`/api/servers/${serverId}/emoji/${emojiId}`, { method: 'DELETE' }),
  setMemberRoles: (serverId: number, userId: number, roleIds: number[]) =>
    req(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role_ids: roleIds }),
    }),
  kickMember: (serverId: number, userId: number) =>
    req(`/api/servers/${serverId}/members/${userId}`, { method: 'DELETE' }),

  serverJoinRequests: (serverId: number): Promise<ServerJoinRequestEntry[]> =>
    req(`/api/servers/${serverId}/requests`),
  approveJoinRequest: (serverId: number, requestId: number) =>
    req(`/api/servers/${serverId}/requests/${requestId}`, { method: 'POST' }),
  declineJoinRequest: (serverId: number, requestId: number) =>
    req(`/api/servers/${serverId}/requests/${requestId}`, { method: 'DELETE' }),

  serverBans: (serverId: number): Promise<ServerBanEntry[]> =>
    req(`/api/servers/${serverId}/bans`),
  banMember: (serverId: number, userId: number, reason = ''): Promise<ServerBanEntry> =>
    req(`/api/servers/${serverId}/bans`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, reason }),
    }),
  unbanMember: (serverId: number, userId: number) =>
    req(`/api/servers/${serverId}/bans/${userId}`, { method: 'DELETE' }),
  createChannel: (serverId: number, name: string, kind: string): Promise<Channel> =>
    req(`/api/servers/${serverId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name, kind }),
    }),

  /** Выйти самому (без исключения/бана) — владелец так выйти не может. */
  leaveServer: (serverId: number) =>
    req(`/api/servers/${serverId}/leave`, { method: 'DELETE' }),

  serverSettings: (serverId: number): Promise<ServerMemberSettings> =>
    req(`/api/servers/${serverId}/settings`),
  /** Заглушение — mute_minutes ИЛИ mute_forever ИЛИ unmute, ровно один из
   * трёх (см. backend chat.views.MyServerSettings); остальные поля — обычный
   * partial-патч. */
  updateServerSettings: (
    serverId: number,
    data: Partial<{
      notification_level: NotificationLevel
      ignore_at_here: boolean
      suppress_role_mentions: boolean
      allow_dms_from_server: boolean
      mute_minutes: number
      mute_forever: boolean
      unmute: boolean
      pinned_channel_ids: number[]
    }>,
  ): Promise<ServerMemberSettings> =>
    req(`/api/servers/${serverId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  /** Личное приглашение конкретному человеку — работает даже для сервера
   * «только по приглашению» (сам факт приглашения от участника — уже
   * разрешение, см. backend). Само приглашение адресат получает карточкой
   * в переписке (см. ChatMessageBase.server_invite), а не отсюда.
   * channelId — приглашение в конкретный голосовой канал (правый клик по
   * каналу → «Пригласить в голосовой чат»); снимает запрет звать уже
   * состоящего на сервере участника, см. backend ServerInvites.post. */
  inviteToServer: (serverId: number, userId: number, channelId?: number): Promise<ServerInviteEntry> =>
    req(`/api/servers/${serverId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, channel_id: channelId }),
    }),
  acceptServerInvite: (inviteId: number): Promise<Server & { invited_channel_id: number | null }> =>
    req(`/api/invites/${inviteId}`, { method: 'POST' }),
  declineServerInvite: (inviteId: number) =>
    req(`/api/invites/${inviteId}`, { method: 'DELETE' }),
  /** Постоянная многоразовая ссылка — СВОЯ у каждого участника (повторные
   * вызовы одним и тем же человеком отдают тот же код, а не плодят новые).
   * uses — сколько людей реально вступило именно по ней. channelId — своя
   * стабильная ссылка на конкретный голосовой канал вместо ссылки на сервер
   * целиком. */
  serverInviteLink: (
    serverId: number,
    channelId?: number,
  ): Promise<{ code: string; uses: number }> =>
    req(
      `/api/servers/${serverId}/invite-link` +
        (channelId != null ? `?channel_id=${channelId}` : ''),
    ),
  /** Модераторский список ВСЕХ пригласительных ссылок сервера — у каждого
   * участника своя (см. serverInviteLink выше), тут видно разом, кто сколько
   * людей привёл. Требует manage_members. */
  serverInviteLinks: (serverId: number): Promise<ServerInviteLinkEntry[]> =>
    req(`/api/servers/${serverId}/invite-links`),
  /** Предпросмотр ссылки БЕЗ вступления — только для ссылок на конкретный
   * канал (см. backend InvitePreview); обычные серверные ссылки 404. */
  invitePreview: (code: string): Promise<InvitePreview> =>
    req(`/api/invites/preview?code=${encodeURIComponent(code)}`),
  redeemServerInvite: (code: string): Promise<Server & { invited_channel_id: number | null }> =>
    req('/api/invites/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
  setChannelStatus: (channelId: number, status: string): Promise<Channel> =>
    req(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  /** before — страница старше указанного сообщения (скролл вверх),
   *  after — то, что появилось после (добор пропущенного, когда WS лежал). */
  messages: (
    channelId: number,
    opts: { before?: number; after?: number; limit?: number } = {},
  ): Promise<Message[]> =>
    req(`/api/channels/${channelId}/messages${buildQuery(opts)}`),
  /** Закреплённые сообщения канала, последнее закреплённое первым. Отдельно
   * от ленты: закреплённое может лежать сколь угодно далеко в истории. */
  channelPins: (channelId: number): Promise<Message[]> =>
    req(`/api/channels/${channelId}/pins`),
  voiceCredentials: (
    channelId: number,
  ): Promise<{ sfu_url: string; sfu_token: string; ttl: number }> =>
    req(`/api/channels/${channelId}/voice-credentials`, { method: 'POST' }),

  friends: (): Promise<FriendsState> => req('/api/friends'),
  sendFriendRequest: (
    target: { userId: number } | { username: string },
  ): Promise<{ id: number; status: string }> =>
    req('/api/friends/requests', {
      method: 'POST',
      body: JSON.stringify(
        'userId' in target ? { user_id: target.userId } : { username: target.username },
      ),
    }),
  acceptFriendRequest: (requestId: number): Promise<{ id: number; status: string }> =>
    req(`/api/friends/requests/${requestId}/accept`, { method: 'POST' }),
  declineFriendRequest: (requestId: number) =>
    req(`/api/friends/requests/${requestId}`, { method: 'DELETE' }),
  removeFriend: (userId: number) =>
    req(`/api/friends/${userId}`, { method: 'DELETE' }),

  knownPeople: (): Promise<KnownPerson[]> => req('/api/people/known'),

  conversations: (): Promise<Conversation[]> => req('/api/conversations'),
  createConversation: (data: {
    kind: ConversationKind
    user_ids: number[]
    name?: string
  }): Promise<Conversation> =>
    req('/api/conversations', { method: 'POST', body: JSON.stringify(data) }),
  conversationMessages: (
    conversationId: number,
    opts: { before?: number; after?: number; limit?: number } = {},
  ): Promise<ConversationMessage[]> =>
    req(`/api/conversations/${conversationId}/messages${buildQuery(opts)}`),
  /** Выйти из беседы. Раньше выхода не существовало вовсе — из группы,
   *  в которую тебя добавили, деться было некуда. */
  leaveConversation: (conversationId: number) =>
    req(`/api/conversations/${conversationId}`, { method: 'DELETE' }),
  /** Личные настройки беседы: закрепить вверху и/или «закрыть» (убрать из
   * списка, не удаляя ни историю, ни участие — вернётся сама при новом
   * сообщении, см. backend ConversationSettings). */
  updateConversationSettings: (
    conversationId: number,
    data: { pinned?: boolean; closed?: boolean },
  ): Promise<{ pinned: boolean; closed: boolean }> =>
    req(`/api/conversations/${conversationId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /** Все, кого я игнорирую/заблокировал — грузится один раз на старте, чтобы
   * отсеивать живые сообщения из WebSocket (REST-ленты сервер фильтрует сам). */
  myRelations: (): Promise<
    { user_id: number; ignored: boolean; blocked: boolean }[]
  > => req('/api/relations'),
  getUserRelation: (userId: number): Promise<UserRelation> =>
    req(`/api/users/${userId}/relation`),
  setUserRelation: (
    userId: number,
    data: { ignored?: boolean; blocked?: boolean },
  ): Promise<UserRelation> =>
    req(`/api/users/${userId}/relation`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  conversationVoiceCredentials: (
    conversationId: number,
  ): Promise<{ sfu_url: string; sfu_token: string; ttl: number }> =>
    req(`/api/conversations/${conversationId}/voice-credentials`, { method: 'POST' }),

  /** Онлайн-статус друзей и собеседников — снимок на старте, дальше карта
   * живёт по presence_update из WebSocket (см. presence.ts). Ростер сервера
   * везёт свой статус сам и сюда не входит. */
  presence: (): Promise<{ user_id: number; status: EffectiveStatus }[]> =>
    req('/api/presence'),

  /** Все никнеймы, которые я кому-то дал, — как и myRelations, одним списком
   * на старте (см. nicknames.ts). */
  myNicknames: (): Promise<{ user_id: number; nickname: string }[]> =>
    req('/api/nicknames'),
  /** Пустая строка снимает никнейм (бэкенд удаляет запись). */
  setUserNickname: (userId: number, nickname: string): Promise<{ nickname: string }> =>
    req(`/api/users/${userId}/nickname`, {
      method: 'PUT',
      body: JSON.stringify({ nickname }),
    }),
}
