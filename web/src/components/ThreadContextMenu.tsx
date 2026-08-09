import { useLayoutEffect, useRef } from 'react'
import {
  Archive, ArchiveRestore, Bell, CheckCheck, Link as LinkIcon, Lock, LogIn, LogOut,
  Maximize2, Pencil, Pin, Search, Trash2, Unlock, Users, VolumeX,
} from 'lucide-react'
import { Channel } from '../api'

/** Что можно делать с этой веткой — считается один раз в вызывающем и
 * передаётся сюда готовым: меню не должно само разбираться в ролях. */
export interface ThreadAbilities {
  /** Автор ветки либо модератор: закрыть, переименовать. */
  manage: boolean
  /** Только модератор: заблокировать и удалить насовсем. */
  moderate: boolean
}

/**
 * Правый клик по ветке — по её плашке под сообщением, по строке в сайдбаре
 * или по ссылке в системной записи. Набор пунктов один и тот же везде: это
 * действия над самой веткой, а не над местом, откуда её открыли.
 *
 * Устроено как ChannelContextMenu/MessageContextMenu: то же позиционирование
 * с прижатием к краю экрана и то же закрытие по клику мимо/Esc. Флайаутов
 * здесь нет — заглушение и параметры уведомлений открываются отдельными
 * модалками уже после закрытия меню (у ветки их всего два пункта против
 * восьми у канала, и вложенная панель ради них была бы тяжелее самого меню).
 *
 * Пункты, которых у обычного участника быть не должно (заблокировать,
 * удалить), не прячутся «на всякий случай», а действительно отсутствуют —
 * бэкенд их всё равно не даст (см. chat.views.ThreadLock/ChannelDetail).
 */
export default function ThreadContextMenu({
  thread,
  x,
  y,
  abilities,
  onClose,
  onOpen,
  onMarkRead,
  onToggleJoin,
  onToggleArchived,
  onToggleLocked,
  onRename,
  onMembers,
  onCopyLink,
  onMute,
  onDelete,
  onExpand,
  onSearch,
  onPins,
}: {
  thread: Channel
  x: number
  y: number
  abilities: ThreadAbilities
  onClose: () => void
  onOpen: () => void
  onMarkRead: () => void
  onToggleJoin: () => void
  onToggleArchived: () => void
  onToggleLocked: () => void
  onRename: () => void
  onMembers: () => void
  onCopyLink: () => void
  onMute: () => void
  onDelete: () => void
  /** Три пункта ниже есть только у меню-многоточия в шапке самой панели: они
   * про то, КАК смотреть уже открытую ветку. В меню по правому клику из
   * списка их нет — там ветка ещё не открыта, и разворачивать/искать пока
   * нечего. */
  onExpand?: () => void
  onSearch?: () => void
  onPins?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

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
    el.style.left = `${Math.max(margin, left)}px`
    el.style.top = `${Math.max(margin, top)}px`
  }, [x, y])

  useLayoutEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (ref.current?.contains(e.target as Node)) return
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

  /** Каждый пункт сам закрывает меню: это однократный выбор действия, а не
   * рабочая панель (тот же принцип, что и в MessageContextMenu). */
  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div ref={ref} className="profile-popup channel-context-menu" style={{ left: x, top: y }}>
      <div className="profile-popup-label">{thread.name}</div>
      <div className="profile-popup-menu">
        {/* В шапке уже открытой ветки «открыть» бессмысленно — там вместо
            него «на весь экран». */}
        {onExpand ? (
          <button type="button" className="profile-popup-item" onClick={act(onExpand)}>
            <Maximize2 size={15} /> Открыть на весь экран
          </button>
        ) : (
          <button type="button" className="profile-popup-item" onClick={act(onOpen)}>
            <LogIn size={15} /> Открыть ветку
          </button>
        )}
        <button type="button" className="profile-popup-item" onClick={act(onMarkRead)}>
          <CheckCheck size={15} /> Пометить как прочитанное
        </button>
        <button type="button" className="profile-popup-item" onClick={act(onToggleJoin)}>
          {thread.joined ? <LogOut size={15} /> : <LogIn size={15} />}
          {thread.joined ? 'Покинуть ветку' : 'Присоединиться к ветке'}
        </button>

        {abilities.manage && (
          <>
            <button
              type="button"
              className="profile-popup-item"
              onClick={act(onToggleArchived)}
            >
              {thread.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              {thread.archived ? 'Открыть ветку заново' : 'Закрыть ветку'}
            </button>
            <button type="button" className="profile-popup-item" onClick={act(onRename)}>
              <Pencil size={15} /> Редактировать ветку
            </button>
          </>
        )}
        {/* Состав есть у любой ветки, но управлять им осмысленно только у
            приватной: в обычную человек заходит сам (см. ThreadMembersModal). */}
        {thread.invite_only && (
          <button type="button" className="profile-popup-item" onClick={act(onMembers)}>
            <Users size={15} /> Участники ветки
          </button>
        )}
        {abilities.moderate && (
          <button
            type="button"
            className="profile-popup-item"
            onClick={act(onToggleLocked)}
          >
            {thread.locked ? <Unlock size={15} /> : <Lock size={15} />}
            {thread.locked ? 'Разблокировать ветку' : 'Заблокировать ветку'}
          </button>
        )}

        {(onSearch || onPins) && <div className="profile-popup-divider" />}
        {onSearch && (
          <button type="button" className="profile-popup-item" onClick={act(onSearch)}>
            <Search size={15} /> Поиск
          </button>
        )}
        {onPins && (
          <button type="button" className="profile-popup-item" onClick={act(onPins)}>
            <Pin size={15} /> Закреплённые
          </button>
        )}

        <button type="button" className="profile-popup-item" onClick={act(onCopyLink)}>
          <LinkIcon size={15} /> Копировать ссылку
        </button>

        <div className="profile-popup-divider" />

        <button type="button" className="profile-popup-item" onClick={act(onMute)}>
          {thread.my_settings.muted ? <Bell size={15} /> : <VolumeX size={15} />}
          {thread.my_settings.muted ? 'Включить уведомления' : 'Заглушить ветку'}
        </button>

        {abilities.moderate && (
          <>
            <div className="profile-popup-divider" />
            <button
              type="button"
              className="profile-popup-item profile-popup-item-danger"
              onClick={act(onDelete)}
            >
              <Trash2 size={15} /> Удалить ветку
            </button>
          </>
        )}
      </div>
    </div>
  )
}
