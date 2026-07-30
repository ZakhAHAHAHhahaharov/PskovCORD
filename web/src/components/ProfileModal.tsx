import { useRef, useState, ChangeEvent } from 'react'
import { Blocks, Calendar, Check, Copy, MessageSquare, Paintbrush, Plus, X } from 'lucide-react'
import { useAuth } from '../auth'
import { api, Me } from '../api'
import { useEscToClose } from '../modalStack'
import { useIsMobile } from '../hooks/useIsMobile'
import { AVATAR_SIZE, fileToSquareDataUrl } from '../images'
import ProfileCardHeader from './ProfileCardHeader'
import BannerEditorModal from './BannerEditorModal'
import StatusEditModal from './StatusEditModal'
import ProfileStylesFlyout from './ProfileStylesFlyout'
import DisplayNameStyleModal from './DisplayNameStyleModal'
import InlineEditableText from './InlineEditableText'

const BIO_MAX_LENGTH = 300

/**
 * Профиль пользователя — всплывает поверх страницы (как в Discord). Вся
 * карточка редактируется прямо на месте — отображаемое имя, местоимения,
 * bio (InlineEditableText, см. ProfileCardHeader), аватар/баннер (hover-
 * меню, см. ImageHoverMenu) — кнопки "Сохранить" нет вообще: потеря
 * фокуса поля коммитит изменение сразу PATCH-запросом. Закрытие модалки
 * (крестик/Esc/клик мимо) само снимает фокус с активного поля ПЕРЕД
 * закрытием — см. handleClose — чтобы недописанное значение успело
 * сохраниться тем же путём, что обычный blur.
 *
 * Смена НИКА (username) отсюда убрана — он остаётся идентификатором
 * аккаунта и меняется только в Settings → «Учётная запись» (требует
 * подтверждения паролем, см. SettingsModal.UsernameChangeModal).
 * Смена пароля и "Кто может мне писать" тоже убраны — первое дублирует
 * Settings → «Пароль и безопасность», второе переехало в Settings →
 * «Контент и общение». Открывается из ChannelSidebar (иконка в
 * user-panel-actions).
 */
export default function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, updateLocalUser } = useAuth()
  const isMobile = useIsMobile()
  const fileRef = useRef<HTMLInputElement>(null)
  const [showBannerEditor, setShowBannerEditor] = useState(false)
  const [showStatusEditor, setShowStatusEditor] = useState(false)
  const [showStylesFlyout, setShowStylesFlyout] = useState(false)
  const [showNameStyleModal, setShowNameStyleModal] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Закрытие = коммит того, что сейчас в фокусе (если что-то есть) — без
  // этого набранный, но ещё не потерявший фокус текст пропал бы молча при
  // закрытии модалки, ведь именно blur — единственный путь сохранения.
  const handleClose = () => {
    ;(document.activeElement as HTMLElement)?.blur()
    onClose()
  }

  useEscToClose(handleClose)

  if (!user) return null

  const patch = async (data: Parameters<typeof api.updateProfile>[0]) => {
    const updated: Me = await api.updateProfile(data)
    updateLocalUser(updated)
  }

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAvatarError('')
    try {
      const dataUrl = await fileToSquareDataUrl(file, AVATAR_SIZE)
      await patch({ avatar_image: dataUrl })
    } catch (err) {
      setAvatarError((err as Error).message)
    }
  }

  const copyId = () => {
    navigator.clipboard.writeText(String(user.id)).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  const joinedDate = new Date(user.date_joined).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  // Десктоп: флайаут — отдельная панель СЛЕВА от .modal (position:absolute,
  // см. .styles-flyout в index.css), не двигает сам .modal — .modal-overlay
  // центрирует только его, флайаут вне потока. На мобильном экран слишком
  // узкий, чтобы держать обе панели рядом, поэтому там флайаут вместо этого
  // подменяет собой содержимое ТОЙ ЖЕ .modal (см. ниже) — тот же принцип,
  // что у mobileCategoryOpen в SettingsModal, только без отдельного стейта:
  // showStylesFlyout один на оба случая, ветвимся по isMobile при рендере.
  const stylesFlyout = (
    <ProfileStylesFlyout
      bannerColor={user.banner_color}
      onSetBannerColor={(v) => patch({ banner_color: v })}
      onOpenNameStyle={() => {
        setShowStylesFlyout(false)
        setShowNameStyleModal(true)
      }}
      onClose={() => setShowStylesFlyout(false)}
    />
  )

  return (
    <>
      <div className="modal-overlay" onClick={handleClose}>
        {/* Обёртка вокруг .modal + закладки "Стили" — и тег, и (на десктопе)
            сам флайаут позиционируются от НЕЁ (см. .profile-modal-wrap в
            index.css), а не от .modal: у того overflow-y:auto, который по
            спеке эффективно клипает и overflow-x тоже — всё, что торчит за
            край, было бы им обрезано. */}
        <div className="profile-modal-wrap">
          <button
            type="button"
            className={`profile-styles-tab ${showStylesFlyout ? 'profile-styles-tab-open' : ''}`}
            title={showStylesFlyout ? 'Закрыть' : 'Стили'}
            // Тег — СИБЛИНГ .modal (не внутри него), поэтому клик по нему
            // без остановки всплывал бы до onClick={handleClose} на
            // .modal-overlay и закрывал весь профиль тем же кликом.
            onClick={(e) => {
              e.stopPropagation()
              setShowStylesFlyout((v) => !v)
            }}
          >
            {showStylesFlyout ? <X size={14} /> : <Paintbrush size={14} />}
          </button>

          {!isMobile && showStylesFlyout && stylesFlyout}

          <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
            {isMobile && showStylesFlyout ? (
              stylesFlyout
            ) : (
              <>
                <ProfileCardHeader
                  username={user.username}
                  displayName={user.display_name}
                  avatarColor={user.avatar_color}
                  avatarImage={user.avatar_image}
                  bannerGradient={user.banner_gradient}
                  bannerImage={user.banner_image}
                  bannerColor={user.banner_color}
                  status={user.status}
                  customStatus={user.custom_status}
                  customStatusEmoji={user.custom_status_emoji}
                  pronouns={user.pronouns}
                  nameStyle={user}
                  edit={{
                    onEditAvatar: () => fileRef.current?.click(),
                    onRemoveAvatar: () => patch({ avatar_image: '' }),
                    canRemoveAvatar: !!user.avatar_image,
                    onEditBanner: () => setShowBannerEditor(true),
                    onRemoveBanner: () => patch({ banner_gradient: '', banner_image: '' }),
                    canRemoveBanner: !!(user.banner_gradient || user.banner_image),
                    onSaveDisplayName: (v) => patch({ display_name: v }),
                    onSavePronouns: (v) => patch({ pronouns: v }),
                    onEditStatus: () => setShowStatusEditor(true),
                    onClearStatus: () => patch({ custom_status: '', custom_status_emoji: '' }),
                  }}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="profile-file-input"
                  onChange={handleFileChange}
                />
                {avatarError && <div className="login-error">{avatarError}</div>}

                <div className="profile-modal-actions-row profile-modal-actions-row-stacked">
                  <button
                    type="button"
                    className="profile-popup-item mini-profile-action"
                    disabled
                    title="Нельзя написать самому себе"
                  >
                    <MessageSquare size={15} /> Написать сообщение
                  </button>
                  <button type="button" className="profile-popup-item" onClick={copyId}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    {copied ? 'Скопировано' : 'Копировать ID'}
                  </button>
                </div>

                <div className="profile-popup-divider" />

                <InlineEditableText
                  className="profile-popup-bio"
                  value={user.bio}
                  placeholder="Расскажи о себе"
                  maxLength={BIO_MAX_LENGTH}
                  multiline
                  onSave={(v) => patch({ bio: v })}
                />

                <div className="profile-popup-divider" />

                <div className="profile-modal-section">
                  <div className="profile-modal-section-title">
                    <Calendar size={13} /> В числе участников с
                  </div>
                  <div className="profile-modal-section-value">{joinedDate}</div>
                </div>

                <div className="profile-popup-divider" />

                <div className="profile-modal-section">
                  <div className="profile-modal-section-title">
                    <Blocks size={13} /> Интеграции
                  </div>
                  <button
                    type="button"
                    className="profile-modal-add-integration"
                    onClick={() => alert('Пока не реализовано')}
                  >
                    <Plus size={14} /> Добавить интеграцию
                  </button>
                </div>

                <button className="modal-close" onClick={handleClose}>
                  Закрыть
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Не вложена в .modal-overlay выше — иначе клик мимо этой
          под-модалки (но всё ещё внутри overlay профиля) всплыл бы до его
          onClick и закрыл заодно и сам профиль (тот же приём, что и у
          под-модалок в SettingsModal.tsx). */}
      {showBannerEditor && (
        <BannerEditorModal
          currentGradient={user.banner_gradient}
          currentImage={user.banner_image}
          onSave={(gradient, image) =>
            patch({ banner_gradient: gradient, banner_image: image })
          }
          onClose={() => setShowBannerEditor(false)}
        />
      )}

      {showStatusEditor && (
        <StatusEditModal
          currentEmoji={user.custom_status_emoji}
          currentText={user.custom_status}
          username={user.username}
          avatarColor={user.avatar_color}
          avatarImage={user.avatar_image}
          onSave={(emoji, text) =>
            patch({ custom_status_emoji: emoji, custom_status: text })
          }
          onClose={() => setShowStatusEditor(false)}
        />
      )}

      {showNameStyleModal && (
        <DisplayNameStyleModal
          user={user}
          onSave={(patchData) => patch(patchData)}
          onClose={() => setShowNameStyleModal(false)}
        />
      )}
    </>
  )
}
