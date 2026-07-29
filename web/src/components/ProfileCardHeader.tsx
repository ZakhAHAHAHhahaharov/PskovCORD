import { Pencil, Sparkles } from 'lucide-react'
import Avatar from './Avatar'
import ImageHoverMenu from './ImageHoverMenu'
import InlineEditableText from './InlineEditableText'
import StatusBubble from './StatusBubble'

const PRONOUN_SUGGESTIONS = [
  'he/him', 'she/her', 'they/them', 'he/they', 'she/they',
  'any pronouns', 'ask me',
]

const AVATAR_SIZE = 84

/**
 * Банер + аватарка (внахлёст на границу баннера и тела карточки — тот же
 * приём, что у профиль-карточек Discord/LinkedIn: без него аватар просто
 * "заперт" внутри цветного прямоугольника и карточка читается плоско) +
 * облачко статуса, растущее от аватарки (StatusBubble) + имя + строка
 * username • местоимения • значок — общий верх карточки профиля,
 * переиспользуется в StatusMenu (свой профиль), MiniProfilePopup (чужой) и
 * ProfileModal (живое превью по мере ввода).
 * Сам по себе — только для чтения; чтобы включить редактирование прямо в
 * карточке (используется только в ProfileModal), передать проп `edit`:
 * тогда аватар/баннер/облачко статуса оборачиваются в ImageHoverMenu (клик —
 * мини-меню "Изменить"/"Очистить"), а имя/местоимения — в InlineEditableText
 * вместо обычного текста. Само облачко статуса НЕ редактируется инлайн —
 * "Изменить" открывает StatusEditModal (см. edit.onEditStatus), у него два
 * независимых поля (эмодзи + текст), которым инлайн-текстовому полю не
 * место.
 */
export default function ProfileCardHeader({
  username,
  displayName,
  avatarColor,
  avatarImage,
  bannerGradient,
  bannerImage,
  status,
  customStatus,
  customStatusEmoji,
  pronouns,
  edit,
}: {
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string
  bannerGradient?: string
  bannerImage?: string
  status?: 'online' | 'dnd' | 'offline' | 'invisible'
  /** Пусто (вместе с customStatusEmoji) — облачко не рисуется вовсе (только для чтения). */
  customStatus: string
  customStatusEmoji: string
  /** Пусто — вторая строка обходится без " · местоимения". */
  pronouns: string
  edit?: {
    onEditAvatar: () => void
    onRemoveAvatar: () => void
    canRemoveAvatar: boolean
    onEditBanner: () => void
    onRemoveBanner: () => void
    canRemoveBanner: boolean
    onSaveDisplayName: (value: string) => Promise<void>
    onSavePronouns: (value: string) => Promise<void>
    /** Открывает StatusEditModal (эмодзи + текст, со своей кнопкой «Сохранить»). */
    onEditStatus: () => void
    onClearStatus: () => Promise<void>
  }
}) {
  const avatarNode = (
    <Avatar
      name={username}
      color={avatarColor}
      image={avatarImage}
      size={AVATAR_SIZE}
      status={status}
      showStatus={!!status}
    />
  )

  const hasStatus = !!(customStatus || customStatusEmoji)

  return (
    <div className="profile-card">
      <div
        className="profile-card-banner"
        style={{
          background: bannerImage ? undefined : bannerGradient || undefined,
          backgroundImage: bannerImage ? `url(${bannerImage})` : undefined,
        }}
      >
        {edit && (
          <ImageHoverMenu
            className="profile-banner-hover-menu"
            onEdit={edit.onEditBanner}
            onRemove={edit.onRemoveBanner}
            canRemove={edit.canRemoveBanner}
            removeConfirm="Убрать фон карточки профиля?"
          >
            <Pencil size={13} />
          </ImageHoverMenu>
        )}
      </div>

      <div className="profile-card-body">
        <div className="profile-card-top-row">
          <div className="profile-card-avatar-wrap">
            {edit ? (
              <ImageHoverMenu
                className="profile-avatar-hover-menu"
                onEdit={edit.onEditAvatar}
                onRemove={edit.onRemoveAvatar}
                canRemove={edit.canRemoveAvatar}
                removeConfirm="Удалить аватар?"
              >
                {avatarNode}
              </ImageHoverMenu>
            ) : (
              avatarNode
            )}
          </div>

          {edit ? (
            // В режиме редактирования облачко рисуем ВСЕГДА (даже пустым,
            // с плейсхолдером) — иначе никак не догадаться, что статус
            // вообще можно задать.
            <div className="profile-status-bubble-slot">
              <ImageHoverMenu
                className="profile-status-hover-menu"
                onEdit={edit.onEditStatus}
                onRemove={edit.onClearStatus}
                removeLabel="Очистить"
                removeConfirm="Очистить статус?"
                canRemove={hasStatus}
              >
                <StatusBubble
                  emoji={customStatusEmoji}
                  text={customStatus}
                  placeholder="Добавить статус"
                />
              </ImageHoverMenu>
            </div>
          ) : (
            hasStatus && (
              <div className="profile-status-bubble-slot">
                <StatusBubble emoji={customStatusEmoji} text={customStatus} />
              </div>
            )
          )}
        </div>

        {edit ? (
          <InlineEditableText
            className="profile-card-name"
            value={displayName}
            placeholder={username}
            maxLength={64}
            onSave={edit.onSaveDisplayName}
          />
        ) : (
          <span className="profile-card-name">{displayName || username}</span>
        )}

        <div className="profile-card-meta-line">
          <span className="profile-card-username">{username}</span>
          {edit ? (
            <>
              <span className="profile-card-meta-dot">·</span>
              <InlineEditableText
                className="profile-card-pronouns-input"
                value={pronouns}
                placeholder="местоимения"
                maxLength={24}
                datalistOptions={PRONOUN_SUGGESTIONS}
                onSave={edit.onSavePronouns}
              />
            </>
          ) : (
            !!pronouns && (
              <>
                <span className="profile-card-meta-dot">·</span>
                <span className="profile-card-pronouns">{pronouns}</span>
              </>
            )
          )}
          <button
            type="button"
            className="profile-card-badge"
            title="Значки — скоро"
            onClick={() => alert('Пока не реализовано')}
          >
            <Sparkles size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
