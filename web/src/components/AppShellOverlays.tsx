import { Me } from '../api'
import type { useConversationsData } from '../hooks/useConversationsData'
import type { useInviteLinks } from '../hooks/useInviteLinks'
import type { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import type { useServerData } from '../hooks/useServerData'
import type { useVoiceCall } from '../hooks/useVoiceCall'
import { conversationDisplayName } from '../conversation'
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
}: AppShellOverlaysProps) {
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
          callerUsername={voice.incomingCall.caller.username}
          callerAvatarColor={voice.incomingCall.caller.avatar_color}
          callerAvatarImage={voice.incomingCall.caller.avatar_image}
          conversationLabel={
            conv.conversations.find((c) => c.id === voice.incomingCall!.conversationId)?.kind === 'group'
              ? conversationDisplayName(
                  conv.conversations.find((c) => c.id === voice.incomingCall!.conversationId)!,
                )
              : voice.incomingCall.caller.username
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
        />
      )}
      {participant.contextMenuTarget && (
        <ParticipantContextMenu
          target={participant.contextMenuTarget}
          canManageMembers={
            participant.contextMenuTarget.room.kind === 'channel' &&
            !!server.currentServer?.my_permissions?.manage_members
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
        />
      )}
      {voice.muteVote && voice.voice?.room.kind === 'channel' && voice.voice.room.id === voice.muteVote.channelId && (
        <MuteVoteModal
          vote={{
            channelId: voice.muteVote.channelId,
            targetUserId: voice.muteVote.targetUserId,
            targetUsername:
              server.members.find((m) => m.id === voice.muteVote!.targetUserId)?.username ??
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
