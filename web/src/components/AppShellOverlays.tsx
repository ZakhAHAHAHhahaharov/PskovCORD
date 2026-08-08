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
import MiniProfilePopup, { ProfilePopupTarget, ProfilePopupUser } from './MiniProfilePopup'
import ModeratorPanel from './ModeratorPanel'
import BanMemberModal from './BanMemberModal'
import ParticipantContextMenu from './ParticipantContextMenu'
import MuteVoteModal from './MuteVoteModal'
import ServerContextMenu from './ServerContextMenu'
import ServerPrivacyModal from './ServerPrivacyModal'
import ServerInviteModal from './ServerInviteModal'
import ChannelContextMenu from './ChannelContextMenu'
import ChannelSettingsModal from './ChannelSettingsModal'
import ChannelInviteModal from './ChannelInviteModal'
import CreateChannelModal from './CreateChannelModal'
import CreateThreadModal from './CreateThreadModal'
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
  /** Кого сейчас разбираем в панели модератора, null — панель закрыта.
   * Состояние живёт в AppShell, а не здесь, хотя и открывает, и рисует
   * панель этот компонент: от него зависит СЕТКА .app (появляется четвёртая
   * колонка, см. app-moderator-open в index.css), а класс на ней вешает
   * AppShell — ровно как у app-no-members-col рядом. */
  moderatorTarget: ProfilePopupUser | null
  /** Уйти к сообщению из мини-чата панели — переключает канал и прокручивает
   * ленту (см. AppShell.jumpToMessage). */
  onJumpToMessage: (channelId: number, messageId: number) => void
  setModeratorTarget: (v: ProfilePopupUser | null) => void
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
  moderatorTarget, setModeratorTarget, onJumpToMessage,
}: AppShellOverlaysProps) {
  // Кого баним прямо сейчас (модалка с причиной). Отдельно от
  // moderatorTarget: забанить можно и из контекстного меню, не открывая
  // панель, а из панели — не закрывая её.
  const [banTarget, setBanTarget] = useState<ProfilePopupUser | null>(null)
  // Счётчик «в сводке что-то изменилось» — панель модератора перечитывает
  // себя при его смене (см. reloadToken там). Нужен только для бана: он
  // уходит в отдельную модалку, а не в саму панель.
  const [moderationVersion, setModerationVersion] = useState(0)
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

  // --- модерация из контекстного меню человека (см. FriendContextMenu) ----
  // Роли/бан/кик доступны только внутри текущего сервера — та же ручка
  // api.setMemberRoles/kickMember/banMember, что и в ServerSettingsModal
  // (RolesTab/BansTab), просто вызванная из контекстного меню вместо формы.
  const handleToggleMemberRole = async (
    userId: number,
    roleId: number,
    on: boolean,
    currentRoleIds: number[],
  ) => {
    if (!server.currentServer) return
    const next = on ? [...currentRoleIds, roleId] : currentRoleIds.filter((id) => id !== roleId)
    try {
      await api.setMemberRoles(server.currentServer.id, userId, next)
      void server.reloadMembers()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const handleKickMember = async (userId: number, username: string) => {
    if (!server.currentServer) return
    if (!window.confirm(`Выгнать ${username} с сервера?`)) return
    try {
      await api.kickMember(server.currentServer.id, userId)
      void server.reloadMembers()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  // Бан идёт через модалку (см. BanMemberModal), а не window.prompt: причина
  // уезжает в журнал модерации и в список банов, и набирать её в системном
  // окошке без единого намёка на то, кого именно банишь, — плохая идея.
  // Ошибку модалка показывает у себя и остаётся открытой, поэтому здесь она
  // не глотается, а пробрасывается наружу.
  const handleBanMember = async (userId: number, reason: string) => {
    if (!server.currentServer) return
    await api.banMember(server.currentServer.id, userId, reason)
    void server.reloadMembers()
    setModerationVersion((v) => v + 1)
  }

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
        // выше): его могли удалить из друзей (или, наоборот, добавить) прямо
        // пока меню открыто. Цель не обязательно друг вовсе (см.
        // FriendMenuTarget.isFriend) — тогда живого списка для неё нет,
        // остаётся снимок на момент открытия меню.
        const target = friendMenu.menuTarget
        const liveFriend = conv.friends.friends.find((f) => f.id === target.friend.id)
        const isFriendNow = !!liveFriend
        const friend = liveFriend ?? target.friend

        // Серверный контекст — только если сейчас открыт текстовый канал
        // сервера (в личке/группе server.currentServer всегда null, см.
        // useServerData). Роли/никнейм-на-сервере/кик/бан имеют смысл только
        // тут — то самое «только в текстовых каналах на серверах» из задачи.
        // Ветка — тот же текстовый канал сервера, только вложенный, и
        // «сервером» быть не перестаёт (см. AppShellChat isTextLike).
        const currentChannel = server.currentChannel
        const inServerTextChannel = !!(
          server.currentServer
          && (currentChannel?.kind === 'text' || currentChannel?.kind === 'thread')
        )
        const currentServer = server.currentServer
        const targetMember = inServerTextChannel
          ? server.members.find((m) => m.id === friend.id) ?? null
          : null
        const roles = inServerTextChannel && currentServer ? server.rolesForServer(currentServer.id) : []
        const myPerms = currentServer?.my_permissions
        const iAmOwner = currentServer?.owner === user.id
        const myMember = inServerTextChannel ? server.members.find((m) => m.id === user.id) : null
        // Позиция в иерархии — то же самое, что backend chat.roles.
        // highest_role_position: максимум позиций персональных ролей,
        // владелец — заведомо выше всех. Итоговое решение всё равно
        // перепроверяет сервер, здесь только прячем заведомо недоступные
        // пункты, а не строим точную копию бэкенда.
        const rolePosition = (roleIds: number[]) =>
          roleIds.reduce((max, id) => Math.max(max, roles.find((r) => r.id === id)?.position ?? -1), -1)
        const myPosition = iAmOwner ? Infinity : rolePosition(myMember?.role_ids ?? [])
        const targetPosition = targetMember?.is_owner ? Infinity : rolePosition(targetMember?.role_ids ?? [])
        const canActOnTarget =
          !!targetMember && !targetMember.is_owner && (iAmOwner || targetPosition < myPosition)

        const activeConversationId = conv.activeConversationId
        const canMention = activeConversationId != null || inServerTextChannel

        return (
          <FriendContextMenu
            friend={friend}
            isFriend={isFriendNow}
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
            onAddFriend={() => void conv.handleMiniProfileAddFriend(friend.id)}
            onRemoveFriend={() => void friendMenu.handleRemoveFriend(friend)}
            onRelationChange={(relation) => friendMenu.handleRelationChange(friend, relation)}
            onMention={
              canMention
                ? () => {
                    const member = {
                      id: friend.id, username: friend.username,
                      sharing_screen: false, muted: false, deafened: false,
                    }
                    if (activeConversationId != null) {
                      participant.handleMention(member, { kind: 'conversation', id: activeConversationId })
                    } else if (currentChannel) {
                      participant.handleMention(member, { kind: 'channel', id: currentChannel.id })
                    }
                  }
                : undefined
            }
            onSetServerNickname={
              targetMember && myPerms?.manage_nicknames
                ? () => setServerNicknameUserId(friend.id)
                : undefined
            }
            rolesMenu={
              targetMember
                ? {
                    roles: roles.filter((r) => !r.is_default && !r.is_owner_role),
                    targetRoleIds: targetMember.role_ids,
                    canManage: !!myPerms?.manage_roles && canActOnTarget,
                    onToggle: (roleId, on) =>
                      void handleToggleMemberRole(friend.id, roleId, on, targetMember.role_ids),
                  }
                : undefined
            }
            onOpenModeratorPanel={
              targetMember && myPerms?.manage_server
                ? () => setModeratorTarget(friend)
                : undefined
            }
            onKick={
              targetMember && myPerms?.manage_members && canActOnTarget
                ? () => void handleKickMember(friend.id, friend.username)
                : undefined
            }
            onBan={
              targetMember && (myPerms?.manage_members || myPerms?.ban_members) && canActOnTarget
                ? () => setBanTarget(friend)
                : undefined
            }
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
            onMarkRead={() => server.handleMarkChannelRead(menuChannel)}
            onInvite={() => server.setShowChannelInviteId(menuChannel.id)}
            onTogglePin={() => server.handleTogglePinChannel(server.currentServer!, menuChannel)}
            onCopyLink={() => server.handleCopyChannelLink(server.currentServer!, menuChannel)}
            onSetMute={(minutes) => void server.handleSetChannelMute(menuChannel, minutes)}
            onSetNotificationLevel={(level) =>
              void server.handleSetChannelNotificationLevel(menuChannel, level)
            }
            onOpenSettings={() => server.setShowChannelSettingsId(menuChannel.id)}
            onCloneChannel={() => void server.handleCloneChannel(menuChannel)}
            onCreateThread={() =>
              server.setCreateThreadTarget({ channelId: menuChannel.id })
            }
            onRequestDelete={() => void server.handleDeleteChannel(menuChannel)}
          />
        )
      })()}
      {server.showChannelSettingsId != null && (() => {
        const settingsChannel = server.currentServer?.channels.find(
          (c) => c.id === server.showChannelSettingsId,
        )
        if (!server.currentServer) return null
        if (!settingsChannel) return null
        return (
          <ChannelSettingsModal
            channel={settingsChannel}
            roles={server.rolesForServer(server.currentServer.id)}
            members={server.membersForServer(server.currentServer.id)}
            onClose={() => server.setShowChannelSettingsId(null)}
            onRenamed={(name) => void server.handleRenameChannel(settingsChannel, name)}
            onSetStatus={(status) => void server.handleSetChannelStatus(settingsChannel, status)}
            onSetSlowmode={(seconds) =>
              void server.handleSetChannelSlowmode(settingsChannel, seconds)
            }
            onSetVisibility={(mode) =>
              void server.handleSetChannelVisibility(settingsChannel, mode)
            }
            onSetPrivacy={(isPrivate, allowedRoleIds, allowedUserIds) =>
              void server.handleSetChannelPrivacy(
                settingsChannel, isPrivate, allowedRoleIds, allowedUserIds,
              )
            }
            onSetInvitesPaused={(paused) =>
              void server.handleSetChannelInvitesPaused(settingsChannel, paused)
            }
            onDelete={() => {
              server.setShowChannelSettingsId(null)
              void server.handleDeleteChannel(settingsChannel)
            }}
          />
        )
      })()}
      {server.createChannelKind && (
        <CreateChannelModal
          kind={server.createChannelKind}
          onCreate={(data) =>
            server.handleCreateChannelSubmit(server.createChannelKind!, data)
          }
          onClose={() => server.setCreateChannelKind(null)}
        />
      )}
      {server.createThreadTarget && (() => {
        const parent = server.currentServer?.channels.find(
          (c) => c.id === server.createThreadTarget!.channelId,
        )
        if (!parent) return null
        return (
          <CreateThreadModal
            channelName={parent.name}
            suggestedName={server.createThreadTarget.suggestedName}
            onCreate={server.handleCreateThreadSubmit}
            onClose={() => server.setCreateThreadTarget(null)}
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
      {banTarget && (
        <BanMemberModal
          member={banTarget}
          onBan={(reason) => handleBanMember(banTarget.id, reason)}
          onClose={() => setBanTarget(null)}
        />
      )}
      {/* Панель модератора — не модалка, а КОЛОНКА в сетке .app (см.
          index.css): рендерится здесь, потому что тут же живут и её данные,
          и действия, а место в раскладке ей задаёт grid-column, а не порядок
          в DOM. Права пересчитываются на каждый рендер из живого ростера —
          пока панель открыта, цели могли выдать роль или снять её. */}
      {moderatorTarget && server.currentServer && (() => {
        const currentServer = server.currentServer
        const roles = server.rolesForServer(currentServer.id)
        const myPerms = currentServer.my_permissions
        if (!myPerms.manage_server) return null
        const targetMember = server.members.find((m) => m.id === moderatorTarget.id) ?? null
        const iAmOwner = currentServer.owner === user.id
        const myMember = server.members.find((m) => m.id === user.id)
        const rolePosition = (roleIds: number[]) =>
          roleIds.reduce(
            (max, id) => Math.max(max, roles.find((r) => r.id === id)?.position ?? -1), -1)
        const myPosition = iAmOwner ? Infinity : rolePosition(myMember?.role_ids ?? [])
        const targetPosition = targetMember?.is_owner
          ? Infinity
          : rolePosition(targetMember?.role_ids ?? [])
        const canActOnTarget =
          !!targetMember && !targetMember.is_owner && (iAmOwner || targetPosition < myPosition)
        return (
          <ModeratorPanel
            serverId={currentServer.id}
            target={moderatorTarget}
            roles={roles}
            canManageMembers={!!myPerms.manage_members}
            canBan={!!(myPerms.manage_members || myPerms.ban_members)}
            canActOnTarget={canActOnTarget}
            reloadToken={moderationVersion}
            onClose={() => setModeratorTarget(null)}
            onSendMessage={() => friendMenu.handleSendMessage(moderatorTarget)}
            onKick={() => handleKickMember(moderatorTarget.id, moderatorTarget.username)}
            onBan={() => setBanTarget(moderatorTarget)}
            onJumpToMessage={onJumpToMessage}
            // Тот же гейт, что у флайаута «Роли» в контекстном меню
            // (см. rolesMenu выше): право manage_roles И цель ниже меня.
            // Сама выдача — та же ручка api.setMemberRoles.
            onGrantRole={
              targetMember && myPerms.manage_roles && canActOnTarget
                ? (roleId) => handleToggleMemberRole(
                  moderatorTarget.id, roleId, true, targetMember.role_ids,
                )
                : undefined
            }
          />
        )
      })()}
    </>
  )
}
