import { useState, MouseEvent as ReactMouseEvent } from 'react'
import { MessageCircle, Pin, Users, UserPlus, Check, X } from 'lucide-react'
import { Conversation, FriendsState, User } from '../api'
import { conversationDisplayName } from '../conversation'
import { useNicknamesVersion } from '../nicknames'
import { useUserStatuses } from '../presence'

import Avatar from './Avatar'
import SidebarBottomBar from './SidebarBottomBar'
import UserName from './UserName'
import { VoiceState } from './AppShell'
import { VoiceRosterMember } from './VoiceStage'
import { VoiceStatus } from './VoiceProvider'
import { ProfilePopupUser } from './MiniProfilePopup'

function conversationAvatar(c: Conversation): { name: string; color: string; image: string } {
  const first = c.participants[0]
  if (c.kind === 'dm' && first) {
    return { name: first.username, color: first.avatar_color, image: first.avatar_image }
  }
  return { name: c.name || '#', color: '#5865f2', image: '' }
}

/**
 * Домашний экран (клик по «домику» в ServerRail) — рендерится вместо
 * ChannelSidebar, когда сервер не выбран. Список диалогов/групп + панель
 * друзей (заявки/добавление по нику) в виде вкладок одного aside.
 */
export default function HomeSidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  friends,
  onOpenNewConversation,
  onSendFriendRequest,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  voice,
  voiceRoster,
  voiceTopic,
  voiceStatus,
  user,
  onLeaveVoice,
  onOpenSettings,
  onOpenProfile,
  onOpenUserProfile,
  onConversationContextMenu,
  onFriendContextMenu,
}: {
  conversations: Conversation[]
  activeConversationId: number | null
  onSelectConversation: (c: Conversation) => void
  friends: FriendsState
  onOpenNewConversation: () => void
  onSendFriendRequest: (username: string) => void
  onAcceptFriendRequest: (requestId: number) => void
  onDeclineFriendRequest: (requestId: number) => void
  voice: VoiceState | null
  /** Кто ещё сейчас в том же звонке, что и мы — для Блока 2 в StatusMenu. */
  voiceRoster: VoiceRosterMember[]
  /** У диалогов топика нет — всегда null, проп только ради общей сигнатуры
   * с ChannelSidebar/SidebarBottomBar. */
  voiceTopic: string | null
  voiceStatus: VoiceStatus
  user: User
  onLeaveVoice: () => void
  onOpenSettings: () => void
  onOpenProfile: () => void
  /** Клик по строке друга/заявки — мини-профиль у курсора, как в списке
   * участников сервера (см. MembersList). */
  onOpenUserProfile: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  /** Правый клик по диалогу/группе — меню действий (см.
   * ConversationContextMenu); живёт на уровне AppShell, как и мини-профиль. */
  onConversationContextMenu: (c: Conversation, e: ReactMouseEvent) => void
  /** Правый клик по строке друга — своё меню (см. FriendContextMenu), тоже с
   * уровня AppShell. */
  onFriendContextMenu: (friend: User, e: ReactMouseEvent) => void
}) {
  const [tab, setTab] = useState<'conversations' | 'friends'>('conversations')
  // Подвкладка списка друзей — второй ряд кнопок под «Диалоги»/«Друзья».
  // Раньше на её месте был заголовок-категория «Друзья — N», который ничего
  // не переключал: показывались сразу все, и найти в длинном списке того, кто
  // сейчас в сети, было нечем.
  const [friendsTab, setFriendsTab] = useState<'online' | 'all'>('online')
  const [addUsername, setAddUsername] = useState('')
  // Заголовки диалогов считает conversationDisplayName — чистая функция,
  // читающая стор никнеймов напрямую. Подписка на его версию заставляет
  // список перерисоваться, когда никнейм поменяли: сами по себе
  // conversations при этом не меняются.
  useNicknamesVersion()

  // Статусы друзей — по ним и фильтруется подвкладка «В сети» (см. presence.ts).
  const friendStatuses = useUserStatuses(friends.friends.map((f) => f.id))
  const onlineFriends = friends.friends.filter(
    (f) => (friendStatuses.get(f.id) ?? 'offline') !== 'offline',
  )
  const shownFriends = friendsTab === 'online' ? onlineFriends : friends.friends

  // Закреплённые — всегда вверху, внутри каждой группы порядок остаётся тем,
  // что пришёл с сервера (по времени создания). Сортируем копию: пропсы
  // мутировать нельзя, а .sort() работает на месте.
  const sortedConversations = [...conversations].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned),
  )

  const submitFriendRequest = () => {
    const trimmed = addUsername.trim()
    if (!trimmed) return
    onSendFriendRequest(trimmed)
    setAddUsername('')
  }

  return (
    <aside className="channel-sidebar home-sidebar">
      <header className="sidebar-header">
        <span className="sidebar-title">Личные сообщения</span>
      </header>

      <div className="home-tabs">
        <button
          type="button"
          className={`home-tab ${tab === 'conversations' ? 'active' : ''}`}
          onClick={() => setTab('conversations')}
        >
          <MessageCircle size={15} /> Диалоги
        </button>
        <button
          type="button"
          className={`home-tab ${tab === 'friends' ? 'active' : ''}`}
          onClick={() => setTab('friends')}
        >
          <Users size={15} /> Друзья
          {friends.incoming.length > 0 && (
            <span className="home-tab-badge">{friends.incoming.length}</span>
          )}
        </button>
      </div>

      {tab === 'conversations' ? (
        <div className="home-scroll" style={{ paddingBottom: voice ? 116 : 60 }}>
          <button type="button" className="home-new-btn" onClick={onOpenNewConversation}>
            + Новый диалог/группа
          </button>
          {conversations.length === 0 && (
            <div className="home-empty">Пока нет диалогов — начни новый выше.</div>
          )}
          {sortedConversations.map((c) => {
            const av = conversationAvatar(c)
            return (
              <button
                key={c.id}
                type="button"
                className={`member-row ${activeConversationId === c.id ? 'active' : ''}`}
                onClick={() => onSelectConversation(c)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onConversationContextMenu(c, e)
                }}
              >
                {/* Точка статуса — только у лички: у группы аватар общий, и
                    чей статус он бы показывал, непонятно. */}
                <Avatar
                  name={av.name}
                  color={av.color}
                  image={av.image}
                  size={32}
                  userId={c.kind === 'dm' ? c.participants[0]?.id : undefined}
                  showStatus={c.kind === 'dm' && !!c.participants[0]}
                />
                <div className="member-info">
                  <span className="member-name">{conversationDisplayName(c)}</span>
                  {c.last_message && (
                    <span className="member-voice">{c.last_message.content.slice(0, 42)}</span>
                  )}
                </div>
                {c.pinned && <Pin size={12} className="conversation-pin-mark" />}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="home-scroll" style={{ paddingBottom: voice ? 116 : 60 }}>
          <div className="home-add-friend">
            <input
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitFriendRequest()}
              placeholder="Ник пользователя"
            />
            <button
              type="button"
              className="icon-btn"
              title="Отправить заявку в друзья"
              onClick={submitFriendRequest}
            >
              <UserPlus size={16} />
            </button>
          </div>

          {friends.incoming.length > 0 && (
            <>
              <div className="member-category">Входящие заявки</div>
              {friends.incoming.map((r) => (
                <div key={r.id} className="friend-row">
                  <button
                    type="button"
                    className="member-row"
                    onClick={(e) => onOpenUserProfile(r.user, e)}
                  >
                    <Avatar
                      name={r.user.username}
                      color={r.user.avatar_color}
                      image={r.user.avatar_image}
                      size={28}
                      userId={r.user.id}
                      showStatus
                    />
                    <span className="member-name">{r.user.username}</span>
                  </button>
                  <div className="friend-row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="Принять"
                      onClick={() => onAcceptFriendRequest(r.id)}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Отклонить"
                      onClick={() => onDeclineFriendRequest(r.id)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {friends.outgoing.length > 0 && (
            <>
              <div className="member-category">Исходящие заявки</div>
              {friends.outgoing.map((r) => (
                <div key={r.id} className="friend-row">
                  <button
                    type="button"
                    className="member-row"
                    onClick={(e) => onOpenUserProfile(r.user, e)}
                  >
                    <Avatar
                      name={r.user.username}
                      color={r.user.avatar_color}
                      image={r.user.avatar_image}
                      size={28}
                      userId={r.user.id}
                      showStatus
                    />
                    <span className="member-name dim">{r.user.username}</span>
                  </button>
                  <div className="friend-row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="Отозвать заявку"
                      onClick={() => onDeclineFriendRequest(r.id)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          <div className="home-subtabs">
            <button
              type="button"
              className={`home-tab ${friendsTab === 'online' ? 'active' : ''}`}
              onClick={() => setFriendsTab('online')}
            >
              В сети <span className="home-tab-count">{onlineFriends.length}</span>
            </button>
            <button
              type="button"
              className={`home-tab ${friendsTab === 'all' ? 'active' : ''}`}
              onClick={() => setFriendsTab('all')}
            >
              Все <span className="home-tab-count">{friends.friends.length}</span>
            </button>
          </div>

          {friends.friends.length === 0 && (
            <div className="home-empty">Пока нет друзей — добавь по нику выше.</div>
          )}
          {friends.friends.length > 0 && shownFriends.length === 0 && (
            <div className="home-empty">Сейчас никого нет в сети.</div>
          )}
          {shownFriends.map((f) => (
            <div key={f.id} className="friend-row">
              <button
                type="button"
                className="member-row"
                onClick={(e) => onOpenUserProfile(f, e)}
                onContextMenu={(e) => onFriendContextMenu(f, e)}
              >
                <Avatar
                  name={f.username}
                  color={f.avatar_color}
                  image={f.avatar_image}
                  size={28}
                  userId={f.id}
                  showStatus
                />
                <UserName user={f} className="member-name" />
              </button>
            </div>
          ))}
        </div>
      )}

      <SidebarBottomBar
        voice={voice}
        voiceRoster={voiceRoster}
        voiceTopic={voiceTopic}
        voiceStatus={voiceStatus}
        user={user}
        onLeaveVoice={onLeaveVoice}
        onOpenSettings={onOpenSettings}
        onOpenProfile={onOpenProfile}
      />
    </aside>
  )
}
