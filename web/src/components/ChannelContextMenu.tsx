import { RefObject, useLayoutEffect, useRef, useState } from 'react'
import {
  Bell, Check, CheckCheck, ChevronRight, Copy, Eye, EyeOff, Link as LinkIcon, Settings,
  Trash2, UserPlus, Pin, Volume2, VolumeX,
} from 'lucide-react'
import { ChannelMemberSettings, ChannelNotifyLevel } from '../api'
import { useHiddenNames } from '../hiddenNames'

export interface ChannelContextMenuChannel {
  id: number
  name: string
  kind: 'text' | 'voice'
  my_settings: ChannelMemberSettings
}

/** Пресеты заглушения канала — сроком, плюс «Пока не включу» (мьют без
 * срока, см. mute_forever). Меньше и грубее, чем у сервера в StatusMenu:
 * канал заглушают на время конкретной темы, а не «пока меня нет», поэтому
 * набор смещён к более коротким интервалам. */
const MUTE_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 минут' },
  { minutes: 60, label: '1 час' },
  { minutes: 180, label: '3 часа' },
  { minutes: 480, label: '8 часов' },
  { minutes: 1440, label: '24 часа' },
]

const NOTIFY_OPTIONS: { value: ChannelNotifyLevel; label: string }[] = [
  { value: 'default', label: 'Использовать стандартные настройки' },
  { value: 'all', label: 'Все сообщения' },
  { value: 'mentions', label: 'Только @упоминания' },
  { value: 'none', label: 'Ничего' },
]

/**
 * Правый клик по каналу в ChannelSidebar. Позиционирование и закрытие по
 * клику вне себя/Escape — тот же приём, что в ServerContextMenu/
 * MessageContextMenu; флайауты заглушения и уведомлений устроены как
 * ReactionFlyout там же (отдельные плавающие панели-соседи, а не вложенные
 * блоки внутри самого меню) — см. докстринг MessageContextMenu про то же
 * самое решение и docstring-объяснение обработчика клика мимо ниже.
 *
 * Редактирование самого канала (название/тема/медленный режим/приватность)
 * отсюда полностью переехало в ChannelSettingsModal («Настроить канал») —
 * здесь остаются только однократные действия и личные переключатели.
 */
export default function ChannelContextMenu({
  channel,
  x,
  y,
  canManageChannels,
  isPinned,
  onClose,
  onMarkRead,
  onInvite,
  onTogglePin,
  onCopyLink,
  onSetMute,
  onSetNotificationLevel,
  onOpenSettings,
  onCloneChannel,
  onRequestDelete,
}: {
  channel: ChannelContextMenuChannel
  x: number
  y: number
  canManageChannels: boolean
  isPinned: boolean
  onClose: () => void
  onMarkRead: () => void
  onInvite: () => void
  onTogglePin: () => void
  onCopyLink: () => void
  /** minutes — на срок, 'forever' — «Пока не включу», null — снять. */
  onSetMute: (minutes: number | 'forever' | null) => void
  onSetNotificationLevel: (level: ChannelNotifyLevel) => void
  onOpenSettings: () => void
  onCloneChannel: () => void
  onRequestDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [muteFlyoutOpen, setMuteFlyoutOpen] = useState(false)
  const [notifyFlyoutOpen, setNotifyFlyoutOpen] = useState(false)
  const muteBtnRef = useRef<HTMLButtonElement>(null)
  const notifyBtnRef = useRef<HTMLButtonElement>(null)
  const { isHidden, setHidden } = useHiddenNames()
  const isVoice = channel.kind === 'voice'
  const hideNames = isHidden(channel.id)
  const muted = channel.my_settings.muted

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height
    }
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [x, y])

  // Клик мимо и Esc закрывают ВСЁ меню разом, включая открытый флайаут — тот
  // не самостоятельный попап, а часть этого же меню (см. тот же приём и его
  // докстринг в MessageContextMenu). Флайауты — отдельные DOM-узлы (соседи, а
  // не дети ref'а), и клик внутри НИХ не должен закрывать меню: иначе
  // mousedown срывал бы меню (а с ним и флайаут) ещё до того, как за ним
  // придёт click с самим выбором.
  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (ref.current?.contains(e.target as Node)) return
      const flyoutEl = document.querySelector('.channel-ctx-flyout')
      if (flyoutEl?.contains(e.target as Node)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <>
      <div ref={ref} className="profile-popup channel-context-menu" style={{ left: x, top: y }}>
        <div className="profile-popup-label">{channel.name}</div>
        <div className="profile-popup-menu">
          <button type="button" className="profile-popup-item" onClick={act(onMarkRead)}>
            <CheckCheck size={15} /> Пометить как прочитанное
          </button>
          <button type="button" className="profile-popup-item" onClick={act(onInvite)}>
            <UserPlus size={15} /> {isVoice ? 'Пригласить в голосовой чат' : 'Пригласить на канал'}
          </button>
          <button type="button" className="profile-popup-item" onClick={act(onTogglePin)}>
            <Pin size={15} /> {isPinned ? 'Открепить канал' : 'Закрепить канал вверху'}
          </button>
          <button type="button" className="profile-popup-item" onClick={act(onCopyLink)}>
            <LinkIcon size={15} /> Копировать ссылку
          </button>
          {muted ? (
            <button
              type="button"
              className="profile-popup-item"
              onClick={act(() => onSetMute(null))}
            >
              <Volume2 size={15} /> Включить звук
            </button>
          ) : (
            <button
              ref={muteBtnRef}
              type="button"
              className={`profile-popup-item ${muteFlyoutOpen ? 'active' : ''}`}
              onClick={() => {
                setMuteFlyoutOpen((v) => !v)
                setNotifyFlyoutOpen(false)
              }}
            >
              <VolumeX size={15} /> Заглушить канал
              <ChevronRight size={14} className="message-ctx-chevron" />
            </button>
          )}
          <button
            ref={notifyBtnRef}
            type="button"
            className={`profile-popup-item ${notifyFlyoutOpen ? 'active' : ''}`}
            onClick={() => {
              setNotifyFlyoutOpen((v) => !v)
              setMuteFlyoutOpen(false)
            }}
          >
            <Bell size={15} /> Параметры уведомлений
            <ChevronRight size={14} className="message-ctx-chevron" />
          </button>
          {isVoice && (
            <label className="profile-popup-item channel-ctx-checkbox-item">
              <input
                type="checkbox"
                checked={hideNames}
                onChange={(e) => setHidden(channel.id, e.target.checked)}
              />
              {hideNames ? <EyeOff size={15} /> : <Eye size={15} />} Скрыть имена
            </label>
          )}
        </div>

        {canManageChannels && (
          <>
            <div className="profile-popup-divider" />
            <div className="profile-popup-menu">
              <button type="button" className="profile-popup-item" onClick={act(onOpenSettings)}>
                <Settings size={15} /> Настроить канал
              </button>
              <button type="button" className="profile-popup-item" onClick={act(onCloneChannel)}>
                <Copy size={15} /> Клонировать канал
              </button>
              <button
                type="button"
                className="profile-popup-item profile-popup-item-danger"
                onClick={act(onRequestDelete)}
              >
                <Trash2 size={15} /> Удалить канал
              </button>
            </div>
          </>
        )}
      </div>

      {muteFlyoutOpen && (
        <OptionFlyout
          triggerRef={muteBtnRef}
          options={MUTE_PRESETS.map((p) => ({ key: String(p.minutes), label: p.label }))}
          extra={{ key: 'forever', label: 'Пока не включу' }}
          onPick={(key) => {
            onSetMute(key === 'forever' ? 'forever' : Number(key))
            onClose()
          }}
        />
      )}

      {notifyFlyoutOpen && (
        <OptionFlyout
          triggerRef={notifyBtnRef}
          options={NOTIFY_OPTIONS.map((o) => ({
            key: o.value,
            label: o.label,
            selected: o.value === channel.my_settings.notification_level,
          }))}
          onPick={(key) => {
            onSetNotificationLevel(key as ChannelNotifyLevel)
            onClose()
          }}
        />
      )}
    </>
  )
}

/** Флайаут-подменю с колонкой вариантов — заглушение и параметры уведомлений
 * устроены одинаково (список, клик по варианту сразу применяет и закрывает
 * всё меню), различаются только содержимым. Позиционирование — тот же
 * приём, что у ReactionFlyout в MessageContextMenu: справа от кнопки-
 * триггера, с прижатием к краю экрана. */
function OptionFlyout({
  triggerRef,
  options,
  extra,
  onPick,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>
  options: { key: string; label: string; selected?: boolean }[]
  /** Пункт под разделителем — «Пока не включу» у заглушения. */
  extra?: { key: string; label: string }
  onPick: (key: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const el = ref.current
    if (!trigger || !el) return
    const margin = 8
    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = el.getBoundingClientRect()
    let left = triggerRect.right + 4
    if (left + panelRect.width > window.innerWidth - margin) {
      left = triggerRect.left - panelRect.width - 4
    }
    let top = triggerRect.top
    if (top + panelRect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - panelRect.height
    }
    left = Math.max(margin, left)
    top = Math.max(margin, top)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [triggerRef])

  return (
    <div ref={ref} className="profile-popup channel-ctx-flyout">
      <div className="profile-popup-menu">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className="profile-popup-item channel-ctx-option"
            onClick={() => onPick(o.key)}
          >
            <span className={`channel-ctx-radio ${o.selected ? 'checked' : ''}`}>
              {o.selected && <Check size={11} />}
            </span>
            {o.label}
          </button>
        ))}
      </div>
      {extra && (
        <>
          <div className="profile-popup-divider" />
          <div className="profile-popup-menu">
            <button
              type="button"
              className="profile-popup-item"
              onClick={() => onPick(extra.key)}
            >
              {extra.label}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
