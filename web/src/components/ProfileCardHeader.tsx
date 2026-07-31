import { Pencil, Sparkles, Trash2 } from 'lucide-react'
import { useHoverFlyout } from '../hooks/useHoverFlyout'
import { NameStyleSource, styledNameProps } from '../nameStyle'
import Avatar from './Avatar'
import ImageHoverMenu from './ImageHoverMenu'
import InlineEditableText from './InlineEditableText'
import ScrollingText from './ScrollingText'
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
 * тогда аватар/баннер оборачиваются в ImageHoverMenu (клик — мини-меню
 * "Изменить"/"Удалить"), облачко статуса получает СВОЁ горизонтальное
 * микро-меню из двух иконок без подписей по НАВЕДЕНИЮ (не клику — см.
 * .status-bubble-actions), а имя/местоимения — в InlineEditableText вместо
 * обычного текста. Само облачко статуса НЕ редактируется инлайн —
 * "Изменить" открывает StatusEditModal (см. edit.onEditStatus), у него два
 * независимых поля (эмодзи + текст), которым инлайн-текстовому полю не
 * место.
 */
export default function ProfileCardHeader({
  username,
  displayName,
  avatarColor,
  avatarImage,
  userId,
  avatarAnimated = false,
  bannerGradient,
  bannerImage,
  bannerColor,
  status,
  customStatus,
  customStatusEmoji,
  pronouns,
  nameStyle,
  originalName = '',
  edit,
}: {
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string
  /** Чей аватар — нужен, чтобы догрузить гифку анимированного (см.
   * avatarAnim.ts). В карточке профиля она играет ВСЕГДА: карточку
   * открывают осознанно и на время, мельтешения в ленте это не создаёт. */
  userId?: number
  avatarAnimated?: boolean
  bannerGradient?: string
  bannerImage?: string
  /** Фон ПОД баннером — виден только когда bannerImage задан и он с
   * прозрачностью (см. accounts.models.User.banner_color). Для градиента
   * не имеет смысла (тот и так непрозрачный). */
  bannerColor?: string
  status?: 'online' | 'dnd' | 'offline' | 'invisible'
  /** Пусто (вместе с customStatusEmoji) — облачко не рисуется вовсе (только для чтения). */
  customStatus: string
  customStatusEmoji: string
  /** Пусто — вторая строка обходится без " · местоимения". */
  pronouns: string
  /** Стиль ника (шрифт/эффект/цвета, см. nameStyle.ts) — применяется и к
   * тексту-для-чтения, и к самому полю InlineEditableText в режиме edit:
   * выбранный стиль должен быть виден сразу в поле ввода имени, не только
   * после сохранения/в других местах приложения. */
  nameStyle?: NameStyleSource
  /** Настоящий ник человека, когда имя над ним — МОЙ никнейм для него (см.
   * nicknames.ts). Подписывается справа от имени в форме `username*` тем же
   * шрифтом, что и строка username ниже. Пусто — подписи нет вовсе. */
  originalName?: string
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
      userId={userId}
      animated={avatarAnimated}
      playAnimation
    />
  )

  const hasStatus = !!(customStatus || customStatusEmoji)
  const statusActions = useHoverFlyout()

  return (
    <div className="profile-card">
      {/* Меню "Изменить"/"Удалить" — СИБЛИНГ самого баннера, а не внутри
          него: у .profile-card-banner overflow:hidden (ради скруглённых
          углов картинки/градиента), который иначе обрезал бы выпадающий
          поповер меню, растущий НИЖЕ шапки баннера (см. .image-hover-menu-popup).
          .profile-card-banner-wrap ниже — общий позиционируемый контейнер
          без overflow, поэтому поповеру есть где раскрыться. */}
      <div className="profile-card-banner-wrap">
        <div
          className="profile-card-banner"
          style={{
            background: bannerImage ? undefined : bannerGradient || undefined,
            backgroundImage: bannerImage ? `url(${bannerImage})` : undefined,
            // backgroundColor — ОТДЕЛЬНО от background/backgroundImage выше (не
            // через шорткат background, тот сбросил бы его): подложка виднеется
            // сквозь прозрачные пиксели гифки-баннера. Для градиента смысла
            // нет (тот и так непрозрачный), поэтому только когда bannerImage задан.
            backgroundColor: bannerImage ? bannerColor || undefined : undefined,
          }}
        />
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
            // вообще можно задать. Микро-меню — по наведению (не клику,
            // в отличие от ImageHoverMenu у аватара/баннера) и без подписей,
            // только две иконки: карандаш (открывает StatusEditModal) и
            // корзина (очищает статус сразу, без window.confirm — это
            // короткий текст, а не тяжёлая картинка, отменить — секунда).
            // Условный рендер + useHoverFlyout, а не CSS :hover/opacity —
            // см. комментарий у .status-bubble-actions в index.css.
            <div
              className="profile-status-bubble-slot"
              onMouseEnter={statusActions.onMouseEnter}
              onMouseLeave={statusActions.onMouseLeave}
            >
              <StatusBubble
                emoji={customStatusEmoji}
                text={customStatus}
                placeholder="Добавить статус"
              />
              {statusActions.open && (
                <div className="status-bubble-actions">
                  <button
                    type="button"
                    className="status-bubble-action"
                    title="Изменить"
                    onClick={edit.onEditStatus}
                  >
                    <Pencil size={12} />
                  </button>
                  {hasStatus && (
                    <button
                      type="button"
                      className="status-bubble-action status-bubble-action-danger"
                      title="Очистить"
                      onClick={edit.onClearStatus}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )}
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
            className={`profile-card-name ${nameStyle ? styledNameProps(nameStyle).className : ''}`}
            style={nameStyle ? styledNameProps(nameStyle).style : undefined}
            value={displayName}
            placeholder={username}
            maxLength={64}
            onSave={edit.onSaveDisplayName}
          />
        ) : originalName ? (
          // Имя + подпись с настоящим ником. В карточке они делят одну
          // строку, и вместе часто не влезают в её ширину — тогда пара едет
          // бегущей строкой (см. ScrollingText), а не обрезается: обрезка
          // съела бы ровно подпись, ради которой всё и затевалось.
          <ScrollingText className="profile-card-name-line" measureKey={`${displayName}|${originalName}`}>
            <span
              className={`profile-card-name ${nameStyle ? styledNameProps(nameStyle).className : ''}`}
              style={nameStyle ? styledNameProps(nameStyle).style : undefined}
            >
              {displayName || username}
            </span>
            <span className="profile-card-original-name">{originalName}*</span>
          </ScrollingText>
        ) : (
          <span
            className={`profile-card-name ${nameStyle ? styledNameProps(nameStyle).className : ''}`}
            style={nameStyle ? styledNameProps(nameStyle).style : undefined}
          >
            {displayName || username}
          </span>
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
