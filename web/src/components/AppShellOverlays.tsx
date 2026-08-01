import { useState } from 'react'
import { api, Me, Server } from '../api'
import type { useConversationContextMenu } from '../hooks/useConversationContextMenu'
import type { useFriendContextMenu } from '../hooks/useFriendContextMenu'
import type { useConversationsData } from '../hooks/useConversationsData'
import type { useInviteLinks } from '../hooks/useInviteLinks'
import type { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import type { useServerData } from '../hooks/useServerData'
import type { useVoiceCall } from '../hooks/useVoiceCall'
import { conversationDisplayName } from '../conversation'
import { useNickname } from '../nicknames'
import NewConversationModal from './NewConversationModal'
import IncomingCallBanner from './IncomingCallBanner'
import DiscoverModal from './DiscoverModal'
import ServerSettingsModal from './ServerSettingsModal'
import SettingsModal from './SettingsModal'
import ProfileModal from './ProfileModal'
import MiniProfilePopup, { ProfilePopupTarget } from './MiniProfilePopup'
import ParticipantContextMenu from './ParticipantContextMenu'
import MuteVoteModal from './MuteVoteModal'
import ServerContextMenu from './ServerContextMenu'
import ServerPrivacyModal from './ServerPrivacyModal'
import ServerInviteModal from './ServerInviteModal'
import ChannelContextMenu from './ChannelContextMenu'
import ChannelInviteModal from './ChannelInviteModal'
import ConversationContextMenu from './ConversationContextMenu'
import FriendContextMenu from './FriendContextMenu'
import FriendNicknameModal from './FriendNicknameModal'
import ServerNicknameModal from './ServerNicknameModal'
import VoiceInviteJoinModal from './VoiceInviteJoinModal'

interface AppShellOverlaysProps {
  server: ReturnType<typeof useServerData>
  conv: ReturnType<typeof useConversationsData>
  voice: ReturnType<typeof useVoiceCall>
  participant: ReturnType<typeof useParticipantContextMenu>
  inviteLinks: ReturnType<typeof useInviteLinks>
  user: Me
  isMobile: boolean
  logout: () => void
  showSettings: boolean
  closeSettings: () => void
  showProfile: boolean
  setShowProfile: (v: boolean) => void
  profilePopup: ProfilePopupTarget | null
  setProfilePopup: (v: ProfilePopupTarget | null) => void
  conversationMenu: ReturnType<typeof useConversationContextMenu>
  friendMenu: ReturnType<typeof useFriendContextMenu>
  /** Мои серверы — из них выбирается, куда пригласить собеседника. */
  servers: Server[]
}

/** Все модалки/попапы/контекстные меню, наложенные поверх основного layout'а
 * — рендерятся условно по своему id/флагу-состоянию, каждый резолвит
 * актуальный объект (сервер/канал/...) из живых списков при каждом рендере,
 * а не хранит стухший снимок с момента открытия. */
export default function AppShellOverlays({
  server, conv, voice, participant, inviteLinks,
  user, isMobile, logout,
  showSettings, closeSettings, showProfile, setShowProfile,
  profilePopup, setProfilePopup,
  conversationMenu, friendMenu, servers,
}: AppShellOverlaysProps) {
  const menuTarget = conversationMenu.menuTarget
  // Беседу резолвим из живого списка по id, а не берём снимок момента
  // открытия — иначе, например, «Закрепить» рисовало бы прежнее состояние
  // (тот же приём, что и у остальных меню здесь).
  const menuConversation = menuTarget
    ? conv.conversations.find((c) => c.id === menuTarget.conversation.id) ?? menuTarget.conversation
    : null
  const menuPeerId = menuConversation?.participants[0]?.id
  const muteVoteNickname = useNickname(voice.muteVote?.targetUserId)
  const incomingCallerNickname = useNickname(voice.incomingCall?.caller.id)
  // Кому сейчас правим никнейм НА СЕРВЕРЕ (см. ServerNicknameModal) — держим
  // id, а не самого участника: ростер живой, объект успел бы протухнуть.
  const [serverNicknameUserId, setServerNicknameUserId] = useState<number | null>(null)
  return (
    <>
      {conv.showNewConversation && (
        <NewConversationModal
          people={conv.knownPeople}
          onClose={() => conv.setShowNewConversation(false)}
          onCreate={(data) =>
            conv.handleCreateConversation({ kind: data.kind, userIds: data.userIds, name: data.name })
          }
        />
      )}
      {voice.incomingCall && (
        <IncomingCallBanner
          callerId={voice.incomingCall.caller.id}
          callerUsername={voice.incomingCall.caller.username}
          callerAvatarColor={voice.incomingCall.caller.avatar_color}
          callerAvatarImage={voice.incomingCall.caller.avatar_image}
          conversationLabel={
            conv.conversations.find((c) => c.id === voice.incomingCall!.conversationId)?.kind === 'group'
              ? conversationDisplayName(
                  conv.conversations.find((c) => c.id === voice.incomingCall!.conversationId)!,
                )
              : incomingCallerNickname || voice.incomingCall.caller.username
          }
          onAccept={voice.handleAcceptIncomingCall}
          onDecline={voice.handleDeclineIncomingCall}
        />
      )}

      {server.showDiscover && (
        <DiscoverModal
          onClose={() => server.setShowDiscover(false)}
          onJoined={server.handleJoined}
        />
      )}
      {server.showServerSettings && server.currentServer && (
        <ServerSettingsModal
          server={server.currentServer}
          members={server.members}
          onClose={() => server.setShowServerSettings(false)}
          onServerUpdated={server.handleServerUpdated}
          onMembersChanged={server.reloadMembers}
          onRolesChanged={server.reloadRoles}
          isMobile={isMobile}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={closeSettings} onLogout={logout} isMobile={isMobile} />
      )}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {profilePopup && (
        <MiniProfilePopup
          target={profilePopup}
          currentUserId={user.id}
          isFriend={conv.friends.friends.some((f) => f.id === profilePopup.user.id)}
          onClose={() => setProfilePopup(null)}
          onAddFriend={conv.handleMiniProfileAddFriend}
          onSendMessage={conv.handleMiniProfileSendMessage}
          onRemoveFriend={conv.handleRemoveFriend}
        />
      )}
      {menuTarget && menuConversation && (
        <ConversationContextMenu
          conversation={menuConversation}
          x={menuTarget.x}
          y={menuTarget.y}
          isFriend={
            menuPeerId != null && conv.friends.friends.some((f) => f.id === menuPeerId)
          }
          servers={servers}
          onClose={conversationMenu.closeMenu}
          onMarkRead={() => conversationMenu.handleMarkRead(menuConversation.id)}
          onTogglePin={() => void conversationMenu.handleTogglePin(menuConversation)}
          onOpenProfile={() =>
            conversationMenu.handleOpenPeerProfile(menuConversation, menuTarget.x, menuTarget.y)
          }
          onSendMessage={() => conversationMenu.handleSendMessage(menuConversation)}
          onStartCall={() => conversationMenu.handleStartCall(menuConversation.id)}
          // «Добавить заметку» — та же карточка профиля: поле заметки живёт
          // прямо в ней (см. MiniProfilePopup), отдельной модалки для одного
          // текстового поля заводить незачем.
          onAddNote={() =>
            conversationMenu.handleOpenPeerProfile(menuConversation, menuTarget.x, menuTarget.y)
          }
          onCloseConversation={() =>
            void conversationMenu.handleCloseConversation(menuConversation)
          }
          onInviteToServer={(serverId) =>
            void conversationMenu.handleInviteToServer(menuConversation, serverId)
          }
          onRemoveFriend={() => void conversationMenu.handleRemoveFriend(menuConversation)}
          onRelationChange={(relation) =>
            conversationMenu.handleRelationChange(menuConversation, relation)
          }
        />
      )}
      {friendMenu.menuTarget && (() => {
        // Друга резолвим из живого списка (тот же приём, что и у беседы
        // выше): его могли удалить из друзей прямо пока меню открыто.
        const target = friendMenu.menuTarget
        const friend = conv.friends.friends.find((f) => f.id === target.friend.id)
        if (!friend) return null
        return (
          <FriendContextMenu
            friend={friend}
            x={target.x}
            y={target.y}
            servers={servers}
            onClose={friendMenu.closeMenu}
            onOpenProfile={() => friendMenu.handleOpenProfile(friend, target.x, target.y)}
            onSendMessage={() => friendMenu.handleSendMessage(friend)}
            onStartCall={() => void friendMenu.handleStartCall(friend)}
            // «Добавить заметку» — та же карточка профиля, что и у «Профиль»
            // (см. комментарий в ConversationContextMenu про onAddNote).
            onAddNote={() => friendMenu.handleOpenProfile(friend, target.x, target.y)}
            onSetNickname={() => friendMenu.setNicknameTarget(friend)}
            onInviteToServer={(serverId) => void friendMenu.handleInviteToServer(friend, serverId)}
            onRemoveFriend={() => void friendMenu.handleRemoveFriend(friend)}
            onRelationChange={(relation) => friendMenu.handleRelationChange(friend, relation)}
          />
        )
      })()}
      {friendMenu.nicknameTarget && (
        <FriendNicknameModal
          friend={friendMenu.nicknameTarget}
          onSave={(nickname) =>
            friendMenu.handleSaveNickname(friendMenu.nicknameTarget!, nickname)
          }
          onClose={() => friendMenu.setNicknameTarget(null)}
        />
      )}
      {participant.contextMenuTarget && (
        <ParticipantContextMenu
          target={participant.contextMenuTarget}
          canManageMembers={
            participant.contextMenuTarget.room.kind === 'channel' &&
            !!server.currentServer?.my_permissions?.manage_members
          }
          canManageNicknames={!!server.currentServer?.my_permissions?.manage_nicknames}
          canStartMuteVote={!!server.currentServer?.my_permissions?.start_mute_vote}
          canRequestScreenShare={
            !!server.currentServer?.my_permissions?.request_screen_share
          }
          voteDisabled={
            voice.activeMuteVoteChannelId != null &&
            voice.voice?.room.kind === 'channel' &&
            voice.voice.room.id === voice.activeMuteVoteChannelId
          }
          // Голосование за мут / запрос демонстрации / блокировка зрителя
          // демонстрации требуют, чтобы мы сами были ПОЛНОСТЬЮ подключены
          // именно к комнате member'а из target — само меню открывается и
          // без этого (см. ChannelSidebar/VoiceStage), просто эти пункты
          // будут задизейблены.
          voiceActionsEnabled={
            voice.voiceStatus === 'connected' &&
            !!voice.voice &&
            voice.voice.room.kind === participant.contextMenuTarget.room.kind &&
            voice.voice.room.id === participant.contextMenuTarget.room.id
          }
          onClose={() => participant.setContextMenuTarget(null)}
          onMention={(member) => participant.handleMention(member, participant.contextMenuTarget!.room)}
          onDisconnect={voice.handleDisconnectUser}
          onStartMuteVote={voice.handleStartMuteVote}
          onRequestScreenShare={voice.handleRequestScreenShare}
          onWakeUser={voice.handleWakeUser}
          onSetServerNickname={(userId) => setServerNicknameUserId(userId)}
        />
      )}
      {serverNicknameUserId != null && (() => {
        // Участника резолвим из живого ростера (тот же приём, что у беседы и
        // друга выше) — его могли выгнать, пока модалка открыта.
        const target = server.members.find((m) => m.id === serverNicknameUserId)
        if (!target) return null
        return (
          <ServerNicknameModal
            member={target}
            isSelf={target.id === user.id}
            onSave={async (nickname) => {
              if (!server.currentServer) return
              await api.setServerNickname(server.currentServer.id, target.id, nickname)
              // Ростер обновит и WS-событие server_member_nickname, но у
              // самого инициатора ответ ручки уже на руках — не ждём круга
              // через сервер, чтобы имя сменилось сразу.
              server.setMembers((prev) =>
                prev.map((m) =>
                  m.id === target.id ? { ...m, server_nickname: nickname } : m,
                ),
              )
            }}
            onClose={() => setServerNicknameUserId(null)}
          />
        )
      })()}
      {voice.muteVote && voice.voice?.room.kind === 'channel' && voice.voice.room.id === voice.muteVote.channelId && (
        <MuteVoteModal
          vote={{
            channelId: voice.muteVote.channelId,
            targetUserId: voice.muteVote.targetUserId,
            targetUsername:
              muteVoteNickname ||
              server.members.find((m) => m.id === voice.muteVote!.targetUserId)?.username ||
              `Участник ${voice.muteVote.targetUserId}`,
            endsAt: voice.muteVote.endsAt,
          }}
          onCastVote={voice.handleCastMuteVote}
        />
      )}
      {server.serverContextMenuServerId && (() => {
        const menuServer = server.servers.find((s) => s.id === server.serverContextMenuServerId!.id)
        // Сервер мог исчезнуть из списка (вышли/выгнали) прямо пока меню
        // открыто — тогда просто не рендерим его вместо падения на undefined.
        if (!menuServer) return null
        return (
          <ServerContextMenu
            server={menuServer}
            x={server.serverContextMenuServerId.x}
            y={server.serverContextMenuServerId.y}
            canManageServer={
              !!menuServer.my_permissions &&
              (menuServer.my_permissions.manage_server ||
                menuServer.my_permissions.manage_roles ||
                menuServer.my_permissions.manage_members)
            }
            canChangeNickname={!!menuServer.my_permissions?.change_nickname}
            isOwner={menuServer.owner === user.id}
            onClose={() => server.setServerContextMenuServerId(null)}
            onMarkRead={() => server.handleMarkServerRead(menuServer)}
            onInvite={() => server.setShowServerInviteId(menuServer.id)}
            onMute={(minutes) => server.handleMuteServer(menuServer, minutes)}
            onUnmute={() => server.handleUnmuteServer(menuServer)}
            onNotificationLevel={(level) => server.handleSetNotificationLevel(menuServer, level)}
            onToggleIgnoreAtHere={(v) => server.handleToggleIgnoreAtHere(menuServer, v)}
            onToggleSuppressRoleMentions={(v) => server.handleToggleSuppressRoleMentions(menuServer, v)}
            onOpenServerSettings={() => {
              server.selectServer(menuServer)
              server.setShowServerSettings(true)
            }}
            onOpenPrivacy={() => server.setShowServerPrivacyId(menuServer.id)}
            // Свой никнейм на сервере — та же модалка, что и для чужого
            // (см. ServerNicknameModal), просто цель — я сам.
            onChangeNickname={() => {
              server.selectServer(menuServer)
              setServerNicknameUserId(user.id)
            }}
            onLeave={() => server.handleLeaveServer(menuServer)}
          />
        )
      })()}
      {server.showServerInviteId != null && (() => {
        const inviteServer = server.servers.find((s) => s.id === server.showServerInviteId)
        if (!inviteServer) return null
        return (
          <ServerInviteModal
            server={inviteServer}
            people={conv.knownPeople}
            onClose={() => server.setShowServerInviteId(null)}
          />
        )
      })()}
      {server.showServerPrivacyId != null && (() => {
        const privacyServer = server.servers.find((s) => s.id === server.showServerPrivacyId)
        if (!privacyServer) return null
        return (
          <ServerPrivacyModal
            server={privacyServer}
            onClose={() => server.setShowServerPrivacyId(null)}
            onSettingsUpdated={server.patchServerSettings}
          />
        )
      })()}
      {server.channelContextMenuId && (() => {
        // Сервер/канал могли исчезнуть (канал удалили, сами вышли) прямо
        // пока меню открыто — тогда просто не рендерим (см. serverContextMenuServerId).
        const menuChannel = server.currentServer?.channels.find((c) => c.id === server.channelContextMenuId!.id)
        if (!server.currentServer || !menuChannel) return null
        return (
          <ChannelContextMenu
            channel={menuChannel}
            x={server.channelContextMenuId.x}
            y={server.channelContextMenuId.y}
            canManageChannels={!!server.currentServer.my_permissions?.manage_channels}
            isPinned={server.currentServer.my_settings.pinned_channel_ids.includes(menuChannel.id)}
            onClose={() => server.setChannelContextMenuId(null)}
            onInvite={() => server.setShowChannelInviteId(menuChannel.id)}
            onTogglePin={() => server.handleTogglePinChannel(server.currentServer!, menuChannel)}
            onCopyLink={() => server.handleCopyChannelLink(server.currentServer!, menuChannel)}
            onSetStatus={(status) => server.handleSetChannelStatus(menuChannel, status)}
            onSetSlowmode={(seconds) =>
              void server.handleSetChannelSlowmode(menuChannel, seconds)
            }
          />
        )
      })()}
      {server.showChannelInviteId != null && (() => {
        const inviteChannel = server.currentServer?.channels.find((c) => c.id === server.showChannelInviteId)
        if (!server.currentServer || !inviteChannel) return null
        return (
          <ChannelInviteModal
            server={server.currentServer}
            channel={inviteChannel}
            people={conv.knownPeople}
            onClose={() => server.setShowChannelInviteId(null)}
          />
        )
      })()}
      {inviteLinks.voiceInvite && (
        <VoiceInviteJoinModal
          preview={inviteLinks.voiceInvite.preview}
          loading={inviteLinks.voiceInvite.loading}
          error={inviteLinks.voiceInvite.error}
          onConfirm={inviteLinks.handleConfirmVoiceInvite}
          onClose={() => inviteLinks.setVoiceInvite(null)}
        />
      )}
    </>
  )
}
