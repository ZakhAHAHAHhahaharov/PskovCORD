import { MessageCircle, Pencil, Sparkles } from 'lucide-react'
import Avatar from './Avatar'
import ImageHoverMenu from './ImageHoverMenu'
import InlineEditableText from './InlineEditableText'

const PRONOUN_SUGGESTIONS = [
  'he/him', 'she/her', 'they/them', 'he/they', 'she/they',
  'any pronouns', 'ask me',
]

const AVATAR_SIZE = 84

/**
 * Банер + аватарка (внахлёст на границу баннера и тела карточки — тот же
 * приём, что у профиль-карточек Discord/LinkedIn: без него аватар просто
 * "заперт" внутри цветного прямоугольника и карточка читается плоско) +
 * статус-пилюля + имя + строка username • местоимения • значок — общий
 * верх карточки профиля, переиспользуется в StatusMenu (свой профиль),
 * MiniProfilePopup (чужой) и ProfileModal (живое превью по мере ввода).
 * Сам по себе — только для чтения; чтобы включить редактирование прямо в
 * карточке (используется только в ProfileModal), передать проп `edit`:
 * тогда аватар/баннер оборачиваются в ImageHoverMenu, а имя/местоимения/
 * статус — в InlineEditableText вместо обычного текста.
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
  /** Пусто — пилюля статуса не рисуется вовсе (только для чтения). */
  customStatus: string
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
    onSaveCustomStatus: (value: string) => Promise<void>
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
          // В режиме редактирования пилюлю статуса рисуем ВСЕГДА (даже
          // пустой) — иначе никак не догадаться, что статус-текст вообще
          // можно задать: у самого поля нет отдельной подписи за её
          // пределами.
          <div className="profile-status-pill profile-status-pill-editable">
            <MessageCircle size={12} className="profile-status-pill-icon" />
            <InlineEditableText
              className="profile-status-pill-text"
              value={customStatus}
              placeholder="Добавить статус"
              maxLength={64}
              onSave={edit.onSaveCustomStatus}
            />
          </div>
        ) : (
          !!customStatus && (
            <div className="profile-status-pill">
              <MessageCircle size={12} className="profile-status-pill-icon" />
              <span className="profile-status-pill-text">{customStatus}</span>
            </div>
          )
        )}

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
