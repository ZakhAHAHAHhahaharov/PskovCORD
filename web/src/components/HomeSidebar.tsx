import { useState, MouseEvent as ReactMouseEvent } from 'react'
import { MessageCircle, Users, UserPlus, Check, X, Mail } from 'lucide-react'
import { Conversation, FriendsState, ServerInviteEntry, User } from '../api'
import Avatar from './Avatar'
import SidebarBottomBar from './SidebarBottomBar'
import { VoiceState } from './AppShell'
import { VoiceRosterMember } from './VoiceStage'
import { VoiceStatus } from './VoiceProvider'
import { ProfilePopupUser } from './MiniProfilePopup'

function conversationTitle(c: Conversation): string {
  if (c.kind === 'group') {
    return c.name || c.participants.map((p) => p.username).join(', ') || 'Группа'
  }
  return c.participants[0]?.username ?? 'Личное сообщение'
}

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
  serverInvites,
  onAcceptServerInvite,
  onDeclineServerInvite,
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
  /** Приглашения на сервера, адресованные мне — см. AppShell. */
  serverInvites: ServerInviteEntry[]
  onAcceptServerInvite: (invite: ServerInviteEntry) => void
  onDeclineServerInvite: (invite: ServerInviteEntry) => void
}) {
  const [tab, setTab] = useState<'conversations' | 'friends' | 'invites'>('conversations')
  const [addUsername, setAddUsername] = useState('')

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
        <button
          type="button"
          className={`home-tab ${tab === 'invites' ? 'active' : ''}`}
          onClick={() => setTab('invites')}
        >
          <Mail size={15} /> Приглашения
          {serverInvites.length > 0 && (
            <span className="home-tab-badge">{serverInvites.length}</span>
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
          {conversations.map((c) => {
            const av = conversationAvatar(c)
            return (
              <button
                key={c.id}
                type="button"
                className={`member-row ${activeConversationId === c.id ? 'active' : ''}`}
                onClick={() => onSelectConversation(c)}
              >
                <Avatar name={av.name} color={av.color} image={av.image} size={32} />
                <div className="member-info">
                  <span className="member-name">{conversationTitle(c)}</span>
                  {c.last_message && (
                    <span className="member-voice">{c.last_message.content.slice(0, 42)}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      ) : tab === 'invites' ? (
        <div className="home-scroll" style={{ paddingBottom: voice ? 116 : 60 }}>
          {serverInvites.length === 0 && (
            <div className="home-empty">Пока нет приглашений на сервера.</div>
          )}
          {serverInvites.map((invite) => (
            <div key={invite.id} className="friend-row">
              <div className="member-row invite-row">
                <Avatar name={invite.server.name} color="#5865f2" image={invite.server.icon} size={28} />
                <div className="member-info">
                  <span className="member-name">{invite.server.name}</span>
                  <span className="member-voice">от {invite.created_by.username}</span>
                </div>
              </div>
              <div className="friend-row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="Принять"
                  onClick={() => onAcceptServerInvite(invite)}
                >
                  <Check size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Отклонить"
                  onClick={() => onDeclineServerInvite(invite)}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}
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

          <div className="member-category">Друзья — {friends.friends.length}</div>
          {friends.friends.length === 0 && (
            <div className="home-empty">Пока нет друзей — добавь по нику выше.</div>
          )}
          {friends.friends.map((f) => (
            <div key={f.id} className="friend-row">
              <button
                type="button"
                className="member-row"
                onClick={(e) => onOpenUserProfile(f, e)}
              >
                <Avatar name={f.username} color={f.avatar_color} image={f.avatar_image} size={28} />
                <span className="member-name">{f.username}</span>
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
