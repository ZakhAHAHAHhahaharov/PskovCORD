import { MouseEvent as ReactMouseEvent } from 'react'
import { Conversation, Me, User } from '../api'
import type { useConversationsData } from '../hooks/useConversationsData'
import type { useParticipantContextMenu } from '../hooks/useParticipantContextMenu'
import type { useServerData } from '../hooks/useServerData'
import type { useVoiceCall } from '../hooks/useVoiceCall'
import ServerRail from './ServerRail'
import ChannelSidebar from './ChannelSidebar'
import HomeSidebar from './HomeSidebar'
import { ProfilePopupUser } from './MiniProfilePopup'

interface AppShellNavProps {
  server: ReturnType<typeof useServerData>
  conv: ReturnType<typeof useConversationsData>
  voice: ReturnType<typeof useVoiceCall>
  participant: ReturnType<typeof useParticipantContextMenu>
  user: Me
  navigateToContent: () => void
  openMobileSettings: () => void
  openProfilePopup: (user: ProfilePopupUser, e: ReactMouseEvent) => void
  onOpenProfile: () => void
  onConversationContextMenu: (c: Conversation, e: ReactMouseEvent) => void
  onFriendContextMenu: (friend: User, e: ReactMouseEvent) => void
}

/** Единая "nav-панель" — рельса+сайдбар каналов вместе, всегда настоящий
 * flex-контейнер (см. .mobile-nav-pane в index.css; на ПК это первая
 * 312px-колонка общей grid, на мобилке — nav-экран на весь экран,
 * скрывается целиком при переходе в content). */
export default function AppShellNav({
  server, conv, voice, participant, user,
  navigateToContent, openMobileSettings, openProfilePopup, onOpenProfile,
  onConversationContextMenu, onFriendContextMenu,
}: AppShellNavProps) {
  const handleOpenHome = () => {
    server.setServerId(null)
    server.setChannelId(null)
  }

  return (
    <div className="mobile-nav-pane">
      <ServerRail
        servers={server.servers}
        activeId={server.serverId}
        onSelect={server.selectServer}
        onCreate={server.handleCreateServer}
        onDiscover={() => server.setShowDiscover(true)}
        onHome={handleOpenHome}
        homeNotificationCount={
          conv.friends.incoming.length + conv.unreadConversationIds.size
        }
        unreadServerIds={server.unreadServerIds}
        mutedServerIds={server.mutedServerIds}
        onContextMenu={(s, e) => server.setServerContextMenuServerId({ id: s.id, x: e.clientX, y: e.clientY })}
      />

      {server.serverId == null ? (
        <HomeSidebar
          conversations={conv.conversations}
          activeConversationId={conv.activeConversationId}
          onSelectConversation={(c) => {
            conv.handleSelectConversation(c)
            navigateToContent()
          }}
          friends={conv.friends}
          onOpenNewConversation={() => conv.setShowNewConversation(true)}
          onSendFriendRequest={conv.handleSendFriendRequest}
          onAcceptFriendRequest={conv.handleAcceptFriendRequest}
          onDeclineFriendRequest={conv.handleDeclineFriendRequest}
          voice={voice.voice}
          voiceRoster={voice.voiceRoster}
          voiceTopic={voice.voiceTopic}
          voiceStatus={voice.voiceStatus}
          user={user}
          onLeaveVoice={voice.handleLeaveVoice}
          onOpenSettings={openMobileSettings}
          onOpenProfile={onOpenProfile}
          onOpenUserProfile={openProfilePopup}
          onConversationContextMenu={onConversationContextMenu}
          onFriendContextMenu={onFriendContextMenu}
        />
      ) : (
        <ChannelSidebar
          server={server.currentServer}
          channels={server.channels}
          activeChannelId={server.channelId}
          openThreadId={server.openThreadId}
          onOpenThread={(c) => {
            server.handleOpenThread(c)
            navigateToContent()
          }}
          members={server.members}
          voice={voice.voice}
          voiceRoster={voice.voiceRoster}
          voiceTopic={voice.voiceTopic}
          voiceStatus={voice.voiceStatus}
          user={user}
          onSelectText={(c) => {
            server.handleSelectChannel(c)
            navigateToContent()
          }}
          onJoinVoice={(c) => {
            voice.handleJoinVoice(c)
            navigateToContent()
          }}
          onLeaveVoice={voice.handleLeaveVoice}
          onCreateChannel={server.handleCreateChannel}
          categories={server.currentServer?.categories ?? []}
          onMoveChannelToCategory={server.handleMoveChannelToCategory}
          onCategoryContextMenu={server.openCategoryContextMenu}
          onOpenSettings={openMobileSettings}
          onOpenProfile={onOpenProfile}
          onWatchScreen={voice.handleWatchBadge}
          onOpenServerSettings={() => server.setShowServerSettings(true)}
          onParticipantContextMenu={participant.openParticipantContextMenu}
          onOpenParticipantProfile={openProfilePopup}
          onChannelContextMenu={(c, e) => server.setChannelContextMenuId({ id: c.id, x: e.clientX, y: e.clientY })}
          onMoveVoiceUser={voice.handleMoveVoiceUser}
        />
      )}
    </div>
  )
}
