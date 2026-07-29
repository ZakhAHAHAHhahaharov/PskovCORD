import { MessageCircle, Pencil, Sparkles } from 'lucide-react'
import Avatar from './Avatar'
import ImageHoverMenu from './ImageHoverMenu'
import InlineEditableText from './InlineEditableText'

const PRONOUN_SUGGESTIONS = [
  'he/him', 'she/her', 'they/them', 'he/they', 'she/they',
  'any pronouns', 'ask me',
]

/**
 * Банер + аватарка + "облачко" произвольного статуса + имя + строка
 * username • местоимения • значок — общий верх карточки профиля,
 * переиспользуется в StatusMenu (свой профиль), MiniProfilePopup (чужой) и
 * ProfileModal (живое превью по мере ввода). Сам по себе — только для
 * чтения; чтобы включить редактирование прямо в карточке (используется
 * только в ProfileModal), передать проп `edit`: тогда аватар/баннер
 * оборачиваются в ImageHoverMenu, а имя/местоимения — в
 * InlineEditableText вместо обычного текста.
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
  /** Пусто — облачко не рисуется вовсе. */
  customStatus: string
  /** Пусто — вторая строка обходится без " • местоимения". */
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
  }
}) {
  const avatarNode = (
    <Avatar
      name={username}
      color={avatarColor}
      image={avatarImage}
      size={86}
      status={status}
      showStatus={!!status}
    />
  )

  return (
    <div
      className="profile-popup-banner"
      style={{
        background: bannerImage ? undefined : bannerGradient || undefined,
        backgroundImage: bannerImage ? `url(${bannerImage})` : undefined,
      }}
    >
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

      {!!customStatus && (
        <div className="profile-status-bubble">
          <span className="profile-status-bubble-icon">
            <MessageCircle size={11} />
          </span>
          <span className="profile-status-bubble-text">{customStatus}</span>
        </div>
      )}

      {edit ? (
        <InlineEditableText
          className="profile-popup-name"
          value={displayName}
          placeholder={username}
          maxLength={64}
          onSave={edit.onSaveDisplayName}
        />
      ) : (
        <span className="profile-popup-name">{displayName || username}</span>
      )}

      <div className="profile-popup-meta-line">
        <span className="profile-popup-username">{username}</span>
        {edit ? (
          <>
            <span className="profile-popup-meta-dot">•</span>
            <InlineEditableText
              className="profile-popup-pronouns-input"
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
              <span className="profile-popup-meta-dot">•</span>
              <span className="profile-popup-pronouns">{pronouns}</span>
            </>
          )
        )}
        <span className="profile-popup-meta-dot">•</span>
        <button
          type="button"
          className="profile-popup-badge"
          title="Значки — скоро"
          onClick={() => alert('Пока не реализовано')}
        >
          <Sparkles size={13} />
        </button>
      </div>
    </div>
  )
}
