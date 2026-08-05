import { MouseEvent as ReactMouseEvent, useCallback, useState } from 'react'
import { Channel } from '../api'
import { useContextMenuState } from '../contextMenuStack'
import { MessageInputPrefill } from '../components/MessageInput'
import { ParticipantContextMenuMember, ParticipantContextMenuTarget } from '../components/ParticipantContextMenu'

/** Контекстное меню участника голосового канала/звонка (правый клик) — общее
 * для серверного голосового канала И звонка в диалоге/группе, открывается
 * для ЛЮБОГО из них, даже если мы сами сейчас не подключены (какие пункты
 * доступны, решает уже сам рендер ParticipantContextMenu, см.
 * voiceActionsEnabled в AppShell). «Упомянуть» отсюда же — переключает на
 * нужный канал/диалог и подставляет "@Имя " в композер. */
export function useParticipantContextMenu(
  channels: Channel[],
  currentChannel: Channel | null,
  setChannelId: (id: number | null) => void,
  setServerId: (id: number | null) => void,
  setActiveConversationId: (id: number | null) => void,
) {
  const [contextMenuTarget, setContextMenuTarget] = useContextMenuState<ParticipantContextMenuTarget>()
  const [mentionPrefill, setMentionPrefill] = useState<MessageInputPrefill | null>(null)

  const openParticipantContextMenu = useCallback(
    (
      member: ParticipantContextMenuMember,
      e: ReactMouseEvent,
      room: { kind: 'channel' | 'conversation'; id: number | string },
    ) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenuTarget({ member, x: e.clientX, y: e.clientY, room })
    },
    [],
  )

  // «Упомянуть» — для канала сервера переключаемся на текущий выбранный
  // текстовый канал (или на первый текстовый) и подставляем "@Имя " в поле
  // ввода; для звонка в личке/группе подставляем в поле ввода ЭТОГО диалога.
  const handleMention = useCallback(
    (
      member: ParticipantContextMenuMember,
      room: { kind: 'channel' | 'conversation'; id: number | string },
    ) => {
      setContextMenuTarget(null)
      if (room.kind === 'conversation') {
        setServerId(null)
        setActiveConversationId(room.id as number)
        setMentionPrefill({ token: Date.now(), text: `@${member.username} ` })
        return
      }
      const target =
        currentChannel && currentChannel.kind === 'text'
          ? currentChannel
          : channels.find((c) => c.kind === 'text')
      if (!target) return
      setChannelId(target.id)
      setMentionPrefill({ token: Date.now(), text: `@${member.username} ` })
    },
    [channels, currentChannel, setChannelId, setServerId, setActiveConversationId],
  )

  return {
    contextMenuTarget, setContextMenuTarget,
    mentionPrefill,
    openParticipantContextMenu, handleMention,
  }
}
