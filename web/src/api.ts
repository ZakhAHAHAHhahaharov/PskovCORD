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

/** Уровень уведомлений — server-wide вариант (без "как на сервере": сервер
 * сам себе и есть база отсчёта). Канальный вариант — см. ChannelNotifyLevel
 * ниже, у него есть четвёртое значение. */
export type NotifyLevelBase = 'all' | 'mentions' | 'none'
/** Уровень уведомлений ОДНОГО канала — 'default' означает «как на сервере»
 * (см. backend chat.models.ChannelMemberSettings). */
export type ChannelNotifyLevel = 'default' | NotifyLevelBase

/** Личные настройки уведомлений/заглушения ОДНОГО канала — тот же смысл, что
 * у ServerMemberSettings для сервера целиком, но per-канал (см. backend
 * chat.models.ChannelMemberSettings и channel_member_settings_payload). */
export interface ChannelMemberSettings {
  notification_level: ChannelNotifyLevel
  /** Заглушен ПРЯМО СЕЙЧАС — как и у ServerMemberSettings, уже учитывает
   * muted_until на момент ответа сервера. */
  muted: boolean
  muted_until: string | null
  muted_forever: boolean
}

/** Раздел сайдбара, в который сгруппированы каналы сервера.
 *
 * Своих прав у раздела нет: приватность остаётся у самого канала, категория
 * только группирует и задаёт порядок (см. backend chat.models.ChannelCategory). */
export interface ChannelCategory {
  id: number
  server: number
  name: string
  position: number
}

export interface Channel {
  id: number
  server: number
  name: string
  /** Раздел, в котором показан канал; null — «вне разделов». У веток всегда
   * null: ветка живёт под своим родительским каналом, а не в разделе. */
  category: number | null
  /** 'thread' — ветка (Discord: thread). Это тоже канал, а не отдельная
   * сущность: те же сообщения, реакции, закрепления и курсор прочтения,
   * отличается только наличием parent (см. backend chat.models.Channel). */
  kind: 'text' | 'voice' | 'thread'
  position: number
  /** Момент начала текущего разговора (unix-секунды), null если пусто. Только voice. */
  call_started_at: number | null
  /** Статус звонка, который видят все; null если пусто. Только voice. */
  topic: string | null
  /** Персистентный статус канала (правый клик → «Настроить канал» → Обзор),
   * в отличие от эфемерного topic выше — переживает опустение канала. У
   * голосового канала это «статус» («играем в CS»), у текстового — «тема
   * канала», показанная в шапке рядом с именем (см. AppShellChat) — то же
   * самое поле, разная подпись в зависимости от вида канала. */
  status: string
  /** Медленный режим: сколько секунд участник ждёт между своими сообщениями.
   * 0 — выключен. Обходится правом bypass_slowmode. Только для текстовых. */
  slowmode_seconds: number
  /** «Канал со спойлерами» — вход показывает предупреждение о чувствительном
   * контенте, прежде чем открыть канал (см. AppShellNav/ChannelSidebar).
   * Взаимоисключающе с age_restricted — на фронте это один radio-выбор
   * «Видимость контента» (см. ChannelSettingsModal onSetVisibility). */
  is_spoiler: boolean
  /** «Канал с возрастным ограничением» — пока только флаг, без применения:
   * само ограничение доступа по возрасту заведут отдельной задачей. */
  age_restricted: boolean
  /** Приватный канал — виден только управляющим каналами, обладателям ролей
   * из allowed_role_ids и лично допущенным allowed_user_ids; обычное
   * view_channels его не открывает. */
  is_private: boolean
  /** Кому открыт приватный канал по роли. Пусто у публичного. */
  allowed_role_ids: number[]
  /** Кому открыт приватный канал лично (см. вкладка «Права доступа» —
   * снять доступ можно только отсюда, роль этим не трогается). */
  allowed_user_ids: number[]
  /** Личные приглашения в этот канал временно не заводятся (вкладка
   * «Приглашения» → «Приостановить приглашения»). Уже разосланных не
   * касается. */
  invites_paused: boolean
  /** Мои личные настройки уведомлений/заглушения для ЭТОГО канала. */
  my_settings: ChannelMemberSettings
  /** Канал, внутри которого живёт ветка; null у обычных каналов. Своих прав
   * доступа у ветки нет — она видна ровно тем, кому виден родитель. */
  parent: number | null
  /** Сообщение, из которого выросла ветка (правый клик → «Создать ветку»).
   * null у веток, заведённых кнопкой в самом канале, и у обычных каналов. По
   * нему MessageList рисует плашку «Ветка: имя» под самим сообщением. */
  source_message: number | null
  /** Ветка закрыта — в сайдбаре её нет, но она никуда не делась: открывается
   * из плашки под исходным сообщением и из «Архивные ветки» в меню канала.
   * Возвращается сама, если кто-то в неё написал. */
  archived: boolean
  /** Кто завёл ветку — ему можно её закрыть без прав модератора. */
  created_by: number | null
  /** Приватная ветка: видна только тем, кого в неё добавили, и управляющим
   * каналами. Не то же самое, что is_private у канала — там допуск решают
   * роли, здесь только участие. */
  invite_only: boolean
  /** Заблокированная ветка: читать можно, писать — только модераторам, и сама
   * из архива она уже не вернётся (в отличие от просто закрытой). */
  locked: boolean
  /** Сколько сообщений в ветке — цифра в плашке «N сообщений ›». 0 у обычных
   * каналов: плашки у них нет. */
  message_count: number
  /** Последнее сообщение ветки — превью в плашке. null, если пусто. */
  last_message: {
    id: number
    author: User
    content: string
    created_at: string
  } | null
  /** Участвую ли я — от этого зависит, висит ли ветка в сайдбаре (там только
   * свои) и что предлагает меню: «Присоединиться» или «Покинуть». */
  joined: boolean
}

/** Права роли на сервере — 1:1 с булевыми полями chat.models.Role.
 *
 * Сам СПИСОК для редактора (подписи, пояснения, группы, пометка «скоро») сюда
 * больше не копируется — он приезжает с бэка ручкой /api/permissions (см.
 * api.permissionsCatalog и chat/roles.py PERMISSION_FIELDS). Здесь остаётся
 * только тип-объединение: он нужен статически, чтобы `perms.manage_server`
 * в коде проверялся компилятором, а не угадывался строкой. */
export type ServerPermission =
  | 'view_channels'
  | 'manage_channels'
  | 'manage_roles'
  | 'manage_server'
  | 'manage_members'
  | 'ban_members'
  | 'create_invites'
  | 'change_nickname'
  | 'manage_nicknames'
  | 'create_expressions'
  | 'manage_expressions'
  | 'send_messages'
  | 'attach_files'
  | 'send_voice_messages'
  | 'add_reactions'
  | 'use_external_emojis'
  | 'use_external_stickers'
  | 'mention_everyone'
  | 'delete_messages'
  | 'pin_messages'
  | 'bypass_slowmode'
  | 'read_message_history'
  | 'connect'
  | 'speak'
  | 'video'
  | 'start_mute_vote'
  | 'request_screen_share'

export type ServerPermissions = Record<ServerPermission, boolean>

/** Одно право в каталоге для редактора ролей — приезжает с /api/permissions,
 * чтобы подписи и порядок жили ровно в одном месте (chat/roles.py). */
export interface PermissionInfo {
  name: ServerPermission
  label: string
  group: string
  /** Пояснение под названием; "" — название говорит само за себя. */
  hint: string
  /** Фича ещё не сделана — переключатель сохраняется, но ни на что не влияет
   * (в редакторе показывается с пометкой «скоро»). */
  upcoming: boolean
  /** Нельзя снять с роли «Владелец» — бэк всё равно форсит его в True. */
  owner_locked: boolean
}

export interface PermissionsCatalog {
  groups: { id: string; title: string }[]
  permissions: PermissionInfo[]
}

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

/** Предпросмотр ссылки-приглашения в конкретный канал — БЕЗ вступления на
 * сервер (см. backend chat.views.InvitePreview). Показывается в модалке
 * подтверждения перед тем, как реально дёрнуть redeemServerInvite. */
export interface InvitePreview {
  server: { id: number; name: string; icon: string }
  channel: {
    id: number
    name: string
    kind: 'text' | 'voice'
    /** Сколько сейчас в голосовом канале — только у voice: у текстового
     * канала нет понятия «сейчас в нём», только у кого он виден. */
    participant_count?: number
  }
  already_member: boolean
}

export interface Server {
  id: number
  name: string
  owner: number
  created_at: string
  channels: Channel[]
  /** Разделы сайдбара в их порядке. Каналы сюда не вложены — они лежат
   * плоско в channels со своим полем category (см. backend). */
  categories: ChannelCategory[]
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
  /** Есть, только если приглашение — в конкретный канал (см.
   * ChannelInviteModal), а не на сервер целиком. */
  channel: { id: number; name: string } | null
  created_by: User
  created_at: string
  status: ServerInviteStatus
}

/** Одна строка вкладки «Приглашения» в ChannelSettingsModal — кому и когда
 * отправили личное приглашение именно в этот канал (см. api.channelInvites). */
export interface ChannelInviteEntry {
  id: number
  invited_user: User
  status: ServerInviteStatus
  created_at: string
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

/** Действие в журнале модерации (backend chat.models.ServerAuditLog). */
export type AuditAction =
  | 'join'
  | 'leave'
  | 'kick'
  | 'ban'
  | 'unban'
  | 'role_add'
  | 'role_remove'
  | 'nickname'

export interface AuditLogEntry {
  id: number
  /** Кто действовал: модератор, а для join/leave — сам участник. null, если
   * его аккаунт с тех пор удалили. */
  actor: User | null
  action: AuditAction
  /** Подробности своей формы у каждого действия — причина бана, имя и цвет
   * роли, старый/новый никнейм (см. backend chat.audit). */
  details: {
    reason?: string
    role_name?: string
    role_color?: string
    before?: string
    after?: string
    method?: string
    invite_code?: string
    invited_by_username?: string
  }
  created_at: string
}

/** Как участник попал на сервер (backend Membership.JOIN_METHOD_CHOICES). */
export type JoinMethod =
  | 'unknown'
  | 'public'
  | 'invite_link'
  | 'invite_direct'
  | 'request'
  | 'owner'

/** Сводка по участнику для панели модератора — требует права manage_server
 * (см. backend chat.views.ServerMemberModeratorView). Цель может быть уже НЕ
 * участником: тогда is_member=false, а всё, что про членство (роли, дата
 * вступления, способ), пустое — журнал и счётчики остаются. */
export interface ModeratorView {
  user: User
  is_member: boolean
  is_owner: boolean
  stats: {
    messages: number
    links: number
    media: number
    audit_entries: number
  }
  /** Права САМОГО участника, а не смотрящего. */
  permissions: ServerPermissions
  /** Подписи прав — приезжают с бэка, чтобы список названий жил в одном
   * месте (chat/roles.py PERMISSION_FIELDS). */
  permission_labels: Record<string, string>
  role_ids: number[]
  server_nickname: string
  registered_at: string
  joined_at: string | null
  join_method: JoinMethod | null
  join_invite_code: string
  join_invited_by: User | null
  audit_log: AuditLogEntry[]
}

/** Категория мини-чата под счётчиками панели модератора — совпадает с
 * ?kind= у backend ServerMemberMessages. */
export type ModeratorMessageKind = 'all' | 'links' | 'media'

/** Строка мини-чата: сообщение участника вместе с каналом, в котором оно
 * лежит — по нему работает «Перейти к сообщению». Это не полноценный
 * Message: реакции, ответы и закрепление в досье не нужны, а канал, наоборот,
 * нужен (в ленте он и так известен, здесь — нет). */
export interface ModeratorMessage {
  id: number
  channel_id: number
  channel_name: string
  content: string
  created_at: string
  attachments: Attachment[]
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
  /** Голосовое сообщение — записано в клиенте, а не выбрано файлом. Рисуется
   * дорожкой во всю ширину (см. VoiceMessage) и режется собственным правом
   * send_voice_messages. */
  voice: boolean
  /** Длительность записи. Замерена секундомером при записи, а не взята из
   * файла: у webm из MediaRecorder длительности в контейнере обычно нет. */
  duration_ms: number | null
  /** Пики громкости 0..100 — та самая дорожка столбиками. Пустой массив, если
   * посчитать не удалось: плеер тогда рисует ровную полосу. */
  waveform: number[]
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

/** Стикер (backend chat.models.Sticker).
 *
 * format определяет, ЧЕМ его рисовать (см. StickerImage):
 *   'webp'   — картинка; анимированная, если animated,
 *   'lottie' — векторная анимация, проигрывается lottie-web,
 *   'webm'   — видео с альфой в <video>.
 *
 * static_url — первый кадр растровой анимации, то, что видно, пока стикер не
 * играет. У Lottie и WebM он пуст: первый кадр там показывает сам плеер. */
export interface Sticker {
  id: number
  name: string
  /** id набора (StickerPack), в котором лежит стикер. */
  pack: number
  url: string
  static_url: string
  format: 'webp' | 'lottie' | 'webm'
  animated: boolean
  size: number
  created_by: number | null
  created_at: string
}

/** Набор стикеров — вкладка в ленте наборов пикера. server === null у базовых
 * наборов: они видны всем и всегда (см. backend MyStickers). */
export interface StickerPack {
  id: number
  name: string
  server: number | null
  server_name: string
  sort_order: number
  stickers: Sticker[]
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
  /** Опрос, приложенный к сообщению. Есть у меньшинства — null у остальных. */
  poll?: Poll | null
}

/** Системная запись в ленте — её никто не писал, текст собирает клиент из
 * полей (см. MessageList), а не берёт из content: иначе он был бы прибит к
 * языку, на котором его сочинили в момент создания. Пустая строка — обычное
 * сообщение, так у подавляющего большинства. */
export type MessageSystemKind = '' | 'thread_created'

export interface Message extends ChatMessageBase {
  channel: number
  system_kind: MessageSystemKind
  /** Ветка, о которой сообщает системная запись, — по ней строка и
   * кликабельна. null у обычных сообщений. */
  system_thread: { id: number; name: string; archived: boolean } | null
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
  /** Никнейм НА ЭТОМ СЕРВЕРЕ — виден всем участникам, "" если не задан.
   * Не путать с приватным никнеймом друга (см. nicknames.ts): тот вижу
   * только я, этот — весь сервер. */
  server_nickname: string
}

/** Минимум, нужный автокомплиту @упоминаний (MessageInput) и рендеру
 * @упоминаний в тексте сообщения (MessageList) — и Member (ростер сервера),
 * и User (участники диалога/группы) ему удовлетворяют без адаптации. */
export interface MentionCandidate {
  id: number
  username: string
  /** Пусто — отображается только username (см. displayNameOf в nicknames.ts). */
  display_name?: string
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

/** Звук соундборда сервера. Файл клиент грузит по url и играет у себя — в
 * аудиопоток SFU он не подмешивается (см. backend chat/models.py). */
export interface SoundboardSound {
  id: number
  name: string
  /** Необязательный эмодзи на кнопке. */
  emoji: string
  server: number
  url: string
  size: number
  created_by: number | null
  created_at: string
}

export interface PollOption {
  id: number
  text: string
  votes: number
  /** Кто отдал голос за этот вариант. Голосование не тайное — это видно и в
   * интерфейсе (см. PollCard). Отсюда же клиент выводит «мой ли это голос»:
   * отдельного поля нет намеренно, обновления опроса уходят одной рассылкой
   * на всех (см. backend serializers.poll_payload). */
  voter_ids: number[]
}

export interface Poll {
  id: number
  question: string
  /** Можно отметить несколько вариантов. Меняет знаменатель у процентов —
   * см. total_voters. */
  multiple: boolean
  /** Принимает ли голоса прямо сейчас (учитывает и closes_at). */
  open: boolean
  closes_at: string | null
  options: PollOption[]
  total_votes: number
  /** Число ПРОГОЛОСОВАВШИХ. Отличается от total_votes только при multiple, и
   * именно оно там знаменатель процентов. */
  total_voters: number
}

/** Карточка ссылки (см. backend chat/linkpreview.py). Поля кроме url могут
 * быть пустыми строками — сайт мог отдать не всё. */
export interface LinkPreview {
  url: string
  title: string
  description: string
  image: string
  site_name: string
}

/** Ответ глобального поиска (см. api.searchEverywhere).
 *
 * Две раздельные пачки, а не один список: id у Message и ConversationMessage
 * нумеруются независимо, и «сообщение №7» без указания, из какого оно мира,
 * не значит ничего. Куда именно вести по клику, клиент достраивает сам —
 * список серверов с каналами у него уже есть. */
export interface GlobalSearchResult {
  channel_messages: Message[]
  conversation_messages: ConversationMessage[]
}

// Пусто => same-origin (относительные запросы). Для dev задаётся в web/.env.
// Экспортируется, потому что мимо самого api() тоже есть запросы — отправка
// отчётов об ошибках (errorTransport.ts) шлёт свой fetch, и без общей базы в
// dev она уходила бы на Vite (5173) вместо бэкенда.
export const API: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

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

/** Загрузка записанного голосового сообщения.
 *
 * Тот же эндпоинт, что и у обычных вложений, — голосовое и есть вложение,
 * просто с флагом и дорожкой. Отдельной ручки нет намеренно: вся механика
 * (прогресс, отмена, привязка к сообщению при отправке, уборка неотправленных)
 * у них общая и повторять её ради одного поля незачем.
 *
 * duration_ms и waveform считает клиент при записи (см. voiceRecorder.ts) —
 * сервер их только проверяет и обрезает. */
export function uploadVoiceMessage(
  blob: Blob,
  durationMs: number,
  waveform: number[],
  opts: UploadOptions = {},
): Promise<Attachment> {
  const form = new FormData()
  // Имя файла не значит ничего: тип бэкенд определяет по сигнатуре
  // контейнера (chat/uploads.py sniff_voice), а показывать голосовому нечего —
  // у него нет «исходного имени» в принципе.
  form.append('file', blob, 'voice')
  form.append('voice', '1')
  form.append('duration_ms', String(Math.round(durationMs)))
  form.append('waveform', JSON.stringify(waveform))
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

/** Загрузка звука соундборда (нужно право create_expressions на сервере).
 *
 * Расширение в имени файла ни на что не влияет: сервер опознаёт формат по
 * содержимому и сам собирает путь на диске (см. backend sound_upload_to).
 * Передаём исходное имя только чтобы оно было видно в логах/админке. */
export function uploadSound(
  serverId: number,
  name: string,
  file: File,
  emoji: string,
  opts: UploadOptions = {},
): Promise<SoundboardSound> {
  const form = new FormData()
  form.append('name', name)
  form.append('emoji', emoji)
  form.append('file', file, file.name)
  return postForm<SoundboardSound>(`/api/servers/${serverId}/sounds`, form, opts)
}

/** Загрузка стикера (нужно право create_expressions на сервере).
 *
 * Файл уезжает КАК ЕСТЬ, без обработки на клиенте, — в отличие от эмодзи, где
 * первый кадр вырезает браузер. Стикер всё равно перекодируется на сервере
 * целиком (см. backend chat/stickers.py: любая картинка → WebP, растровая
 * анимация → анимированный WebP, Lottie и WebM — как есть), и делать часть
 * той же работы дважды незачем. */
export function uploadSticker(
  serverId: number,
  name: string,
  file: Blob,
  pack?: string,
  opts: UploadOptions = {},
): Promise<Sticker> {
  const form = new FormData()
  form.append('name', name)
  // Blob, а не только File: из редактора уезжает собранная на canvas
  // картинка, у которой имени нет вовсе. Имя тут ни на что и не влияет —
  // формат бэкенд определяет по содержимому и сам решает, во что его
  // перекодировать (см. chat/stickers.py).
  form.append('file', file, file instanceof File ? file.name : 'sticker')
  if (pack) form.append('pack', pack)
  return postForm<Sticker>(`/api/servers/${serverId}/stickers`, form, opts)
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

  /** Каталог прав для редактора ролей (подписи/пояснения/группы/«скоро») —
   * единственный источник правды живёт на бэке, см. chat/roles.py. */
  permissionsCatalog: (): Promise<PermissionsCatalog> => req('/api/permissions'),

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

  // --- соундборд ------------------------------------------------------------
  serverSounds: (serverId: number): Promise<SoundboardSound[]> =>
    req(`/api/servers/${serverId}/sounds`),
  renameSound: (
    serverId: number, soundId: number, name: string, emoji?: string,
  ): Promise<SoundboardSound> =>
    req(`/api/servers/${serverId}/sounds/${soundId}`, {
      method: 'PATCH',
      body: JSON.stringify(emoji === undefined ? { name } : { name, emoji }),
    }),
  deleteSound: (serverId: number, soundId: number) =>
    req(`/api/servers/${serverId}/sounds/${soundId}`, { method: 'DELETE' }),

  // --- стикеры --------------------------------------------------------------
  /** Все доступные мне наборы: базовые (ничьи, видны всем) плюс наборы моих
   * серверов. Как и с эмодзи, напрямую отсюда не читают — есть кэш с
   * подпиской, см. stickers.ts. */
  myStickers: (): Promise<StickerPack[]> => req('/api/stickers'),
  /** Метаданные конкретных стикеров, в том числе с серверов, где меня нет:
   * стикер могли прислать в личку. */
  resolveStickers: (ids: number[]): Promise<Sticker[]> =>
    req(`/api/stickers?ids=${ids.join(',')}`),
  serverStickers: (serverId: number): Promise<StickerPack[]> =>
    req(`/api/servers/${serverId}/stickers`),
  renameSticker: (serverId: number, stickerId: number, name: string): Promise<Sticker> =>
    req(`/api/servers/${serverId}/stickers/${stickerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteSticker: (serverId: number, stickerId: number) =>
    req(`/api/servers/${serverId}/stickers/${stickerId}`, { method: 'DELETE' }),
  setMemberRoles: (serverId: number, userId: number, roleIds: number[]) =>
    req(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role_ids: roleIds }),
    }),
  kickMember: (serverId: number, userId: number) =>
    req(`/api/servers/${serverId}/members/${userId}`, { method: 'DELETE' }),
  moderatorView: (serverId: number, userId: number): Promise<ModeratorView> =>
    req(`/api/servers/${serverId}/members/${userId}/moderator-view`),
  /** Сообщения участника для мини-чата панели модератора. Отдаются в
   * хронологическом порядке, последняя сотня — см. ServerMemberMessages. */
  moderatorMessages: (
    serverId: number, userId: number, kind: ModeratorMessageKind,
  ): Promise<ModeratorMessage[]> =>
    req(`/api/servers/${serverId}/members/${userId}/messages?kind=${kind}`),

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
  // --- разделы сайдбара (категории каналов) --------------------------------
  serverCategories: (serverId: number): Promise<ChannelCategory[]> =>
    req(`/api/servers/${serverId}/categories`),
  createCategory: (serverId: number, name: string): Promise<ChannelCategory> =>
    req(`/api/servers/${serverId}/categories`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateCategory: (
    serverId: number,
    categoryId: number,
    patch: { name?: string; position?: number },
  ): Promise<ChannelCategory> =>
    req(`/api/servers/${serverId}/categories/${categoryId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** Удаляется только раздел — каналы внутри остаются и становятся «вне
   * разделов» (см. backend, SET_NULL). */
  deleteCategory: (serverId: number, categoryId: number) =>
    req(`/api/servers/${serverId}/categories/${categoryId}`, { method: 'DELETE' }),
  /** Перенести канал в раздел; null — вынести из разделов. */
  moveChannelToCategory: (channelId: number, categoryId: number | null): Promise<Channel> =>
    req(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ category: categoryId }),
    }),

  createChannel: (
    serverId: number,
    name: string,
    kind: string,
    opts: { slowmodeSeconds?: number; isPrivate?: boolean; categoryId?: number | null } = {},
  ): Promise<Channel> =>
    req(`/api/servers/${serverId}/channels`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        kind,
        slowmode_seconds: opts.slowmodeSeconds ?? 0,
        is_private: opts.isPrivate ?? false,
        category: opts.categoryId ?? null,
      }),
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
  /** Переименовать канал. Нужно manage_channels. */
  renameChannel: (channelId: number, name: string): Promise<Channel> =>
    req(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** Видимость контента — один radio-выбор на фронте (см.
   * ChannelSettingsModal), а на бэке два независимых поля; отправляем оба
   * разом, чтобы включение одного гарантированно выключало другой. Нужно
   * manage_channels. */
  setChannelVisibility: (
    channelId: number,
    mode: 'default' | 'spoiler' | 'age_restricted',
  ): Promise<Channel> =>
    req(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        is_spoiler: mode === 'spoiler',
        age_restricted: mode === 'age_restricted',
      }),
    }),
  /** Медленный режим канала в секундах (0 — выключить). Нужно manage_channels. */
  setChannelSlowmode: (channelId: number, seconds: number): Promise<Channel> =>
    req(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ slowmode_seconds: seconds }),
    }),
  /** Приватность канала, роли и лично допущенные участники, которым он
   * открыт. Нужно manage_channels. */
  setChannelPrivacy: (
    channelId: number,
    isPrivate: boolean,
    allowedRoleIds: number[],
    allowedUserIds: number[],
  ): Promise<Channel> =>
    req(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        is_private: isPrivate,
        allowed_role_ids: allowedRoleIds,
        allowed_user_ids: allowedUserIds,
      }),
    }),
  /** Точная копия канала (название, тема, медленный режим, приватность,
   * спойлер), БЕЗ единого сообщения. Нужно manage_channels. */
  cloneChannel: (channelId: number): Promise<Channel> =>
    req(`/api/channels/${channelId}/clone`, { method: 'POST' }),
  /** Безвозвратно удалить канал — каскадом уносит сообщения, вложения,
   * закрепления и ветки канала. Нужно manage_channels. */
  deleteChannel: (channelId: number) =>
    req(`/api/channels/${channelId}`, { method: 'DELETE' }),

  /** Завести ветку в канале. messageId — если ветка растёт из конкретного
   * сообщения (правый клик → «Создать ветку»). Своего права не требует:
   * достаточно уметь писать в этот канал. Ветка из того же сообщения уже
   * есть — бэкенд вернёт её (200 вместо 201), а не заведёт вторую. Сам
   * список веток отдельной ручкой не забирается: ветки приезжают обычными
   * каналами в составе сервера. */
  createThread: (
    channelId: number,
    opts: { name?: string; messageId?: number; inviteOnly?: boolean } = {},
  ): Promise<Channel> =>
    req(`/api/channels/${channelId}/threads`, {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name ?? '',
        message_id: opts.messageId ?? null,
        invite_only: opts.inviteOnly ?? false,
      }),
    }),
  /** ВСЕ ветки канала, включая закрытые и те, где я не участвую, — «Показать
   * все ветки». В составе сервера приезжают не все: сайдбар показывает только
   * свои. Приватные, куда не звали, не попадают и сюда. */
  channelThreads: (channelId: number): Promise<Channel[]> =>
    req(`/api/channels/${channelId}/threads`),
  /** «Присоединиться к ветке» / «Покинуть ветку». Написать в ветку — то же
   * самое участие, только без отдельного нажатия. */
  joinThread: (channelId: number): Promise<Channel> =>
    req(`/api/channels/${channelId}/membership`, { method: 'POST' }),
  leaveThread: (channelId: number): Promise<Channel> =>
    req(`/api/channels/${channelId}/membership`, { method: 'DELETE' }),
  /** Кто в ветке. Нужно вкладке участников приватной ветки. */
  threadMembers: (channelId: number): Promise<User[]> =>
    req(`/api/channels/${channelId}/members`),
  /** Добавить людей в приватную ветку. Можно автору ветки и модератору; тех,
   * кому не виден родительский канал, бэкенд молча пропустит. */
  addThreadMembers: (channelId: number, userIds: number[]): Promise<User[]> =>
    req(`/api/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: userIds }),
    }),
  /** Заблокировать ветку — сильнее закрытия: писать нельзя никому, кроме
   * модераторов, и сама она из архива уже не вернётся. Только модератору. */
  setThreadLocked: (channelId: number, locked: boolean): Promise<Channel> =>
    req(`/api/channels/${channelId}/lock`, {
      method: 'POST',
      body: JSON.stringify({ locked }),
    }),
  /** Поиск по сообщениям канала или ветки — по вхождению подстроки, с теми же
   * правами, что и чтение истории. */
  searchMessages: (channelId: number, query: string): Promise<Message[]> =>
    req(`/api/channels/${channelId}/search?q=${encodeURIComponent(query)}`),
  /** og:title/description/image по ссылке. 404 («превью недоступно») —
   * штатный ответ, а не сбой: показывать просто нечего. */
  linkPreview: (url: string): Promise<LinkPreview> =>
    req(`/api/link-preview?url=${encodeURIComponent(url)}`),
  /** Поиск сразу по всему видимому: каналы и ветки всех серверов плюс личка.
   * serverId сужает до одного сервера — тогда личка не ищется вовсе. */
  searchEverywhere: (query: string, serverId?: number | null): Promise<GlobalSearchResult> =>
    req(
      `/api/search?q=${encodeURIComponent(query)}` +
        (serverId != null ? `&server_id=${serverId}` : ''),
    ),
  /** Закрыть ветку или вернуть её из архива. Может автор ветки, а также
   * manage_channels/delete_messages. Не удаление: сообщения остаются. */
  setThreadArchived: (channelId: number, archived: boolean): Promise<Channel> =>
    req(`/api/channels/${channelId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),

  /** Мои личные настройки уведомлений/заглушения ОДНОГО канала. */
  channelMemberSettings: (channelId: number): Promise<ChannelMemberSettings> =>
    req(`/api/channels/${channelId}/settings`),
  /** Заглушение — mute_minutes ИЛИ mute_forever ИЛИ unmute, ровно один из
   * трёх (см. backend chat.views.ChannelMemberSettingsView), тот же приём,
   * что и у updateServerSettings. */
  updateChannelMemberSettings: (
    channelId: number,
    data: Partial<{
      notification_level: ChannelNotifyLevel
      mute_minutes: number
      mute_forever: boolean
      unmute: boolean
    }>,
  ): Promise<ChannelMemberSettings> =>
    req(`/api/channels/${channelId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /** Модераторский список личных приглашений именно в этот канал — вкладка
   * «Приглашения» в ChannelSettingsModal. Нужно manage_channels. */
  channelInvites: (channelId: number): Promise<ChannelInviteEntry[]> =>
    req(`/api/channels/${channelId}/invites`),
  /** «Приостановить приглашения» — временно не даёт заводить НОВЫЕ личные
   * приглашения в канал; уже отправленные не трогает. Нужно manage_channels. */
  setChannelInvitesPaused: (
    channelId: number,
    paused: boolean,
  ): Promise<{ invites_paused: boolean }> =>
    req(`/api/channels/${channelId}/invites`, {
      method: 'PATCH',
      body: JSON.stringify({ invites_paused: paused }),
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
  /** Докуда я дочитал канал — курсор для «открыть там, где остановился»
   * (см. useChannelMessages). null — ни разу не отмечался (новый канал или
   * первый визит). */
  channelReadState: (channelId: number): Promise<{ last_read_message_id: number | null }> =>
    req(`/api/channels/${channelId}/read`),
  /** Продвинуть курсор прочтения. Без messageId — «прочитано всё, что есть
   * сейчас» (сервер сам возьмёт id самого свежего сообщения). Курсор
   * двигается только вперёд — см. backend ChannelReadStateView. */
  markChannelRead: (
    channelId: number,
    messageId?: number,
  ): Promise<{ last_read_message_id: number | null }> =>
    req(`/api/channels/${channelId}/read`, {
      method: 'POST',
      body: JSON.stringify(messageId != null ? { message_id: messageId } : {}),
    }),
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

  /** Никнейм участника НА СЕРВЕРЕ — виден всем (в отличие от приватного
   * setUserNickname выше). Своё имя требует change_nickname, чужое —
   * manage_nicknames (см. backend ServerMemberNickname). */
  setServerNickname: (
    serverId: number,
    userId: number,
    nickname: string,
  ): Promise<{ user_id: number; nickname: string }> =>
    req(`/api/servers/${serverId}/members/${userId}/nickname`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    }),

  /** Обращение из формы в правом нижнем углу. recent_errors — последние
   * пойманные у этого человека ошибки (см. errorTransport.recentErrors):
   * сервер сам сведёт их с известными группами, поэтому уходит сырой текст,
   * а не идентификаторы. */
  createBugReport: (data: {
    description: string
    steps: string
    route: string
    platform: string
    app_version: string
    recent_errors: { kind: string; message: string; stack?: string }[]
  }): Promise<{ id: number }> =>
    req('/api/bug-reports', { method: 'POST', body: JSON.stringify(data) }),
}
