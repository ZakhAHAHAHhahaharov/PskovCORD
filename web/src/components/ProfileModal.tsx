import { useRef, useState, ChangeEvent } from 'react'
import { Camera, Trash2, Loader2 } from 'lucide-react'
import { useAuth } from '../auth'
import { api } from '../api'
import { useEscToClose } from '../modalStack'
import {
  AVATAR_SIZE, BANNER_MAX_BYTES, BANNER_MAX_H, BANNER_MAX_W, GRADIENT_PRESETS,
  buildGradient, fileToBannerDataUrl, fileToSquareDataUrl, parseGradient,
} from '../images'
import Avatar from './Avatar'

const BIO_MAX_LENGTH = 300
const DISPLAY_NAME_MAX_LENGTH = 64

/**
 * Профиль пользователя — всплывает поверх страницы (как в Discord). Смена
 * отображаемого имени, био и аватара (сжимается на клиенте до 256x256,
 * хранится как data-URL в БД — см. accounts.models.User.avatar_image).
 * Смена НИКА (username) отсюда убрана — он остаётся идентификатором
 * аккаунта и меняется только в Settings → «Учётная запись» (требует
 * подтверждения паролем, см. SettingsModal.UsernameChangeModal); здесь же
 * редактируется только то, что видно в карточке профиля поверх username.
 * Смена пароля и "Кто может мне писать" тоже убраны — первое дублирует
 * Settings → «Пароль и безопасность», второе переехало в Settings →
 * «Контент и общение». Открывается из ChannelSidebar (иконка в
 * user-panel-actions).
 */
export default function ProfileModal({ onClose }: { onClose: () => void }) {
  useEscToClose(onClose)
  const { user, updateLocalUser } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  const [displayName, setDisplayName] = useState(user?.display_name ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [avatarImage, setAvatarImage] = useState(user?.avatar_image ?? '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileSaved, setProfileSaved] = useState(false)

  const initialGradient = parseGradient(user?.banner_gradient ?? '')
  const [bannerMode, setBannerMode] = useState<'gradient' | 'gif'>(
    user?.banner_image ? 'gif' : 'gradient',
  )
  const [gradientFrom, setGradientFrom] = useState(initialGradient.from)
  const [gradientTo, setGradientTo] = useState(initialGradient.to)
  const [gradientAngle, setGradientAngle] = useState(initialGradient.angle)
  const [bannerImage, setBannerImage] = useState(user?.banner_image ?? '')
  const [bannerError, setBannerError] = useState('')

  if (!user) return null

  const currentGradientCss = buildGradient(gradientAngle, gradientFrom, gradientTo)
  const desiredGradient = bannerMode === 'gradient' ? currentGradientCss : ''
  const desiredBannerImage = bannerMode === 'gif' ? bannerImage : ''
  const bannerDirty =
    desiredGradient !== (user.banner_gradient || '') ||
    desiredBannerImage !== (user.banner_image || '')

  const profileDirty =
    displayName.trim() !== (user.display_name || '') ||
    bio.trim() !== (user.bio || '') ||
    avatarImage !== user.avatar_image ||
    bannerDirty

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setProfileError('')
    setProfileSaved(false)
    try {
      setAvatarImage(await fileToSquareDataUrl(file, AVATAR_SIZE))
    } catch (err) {
      setProfileError((err as Error).message)
    }
  }

  const handleBannerFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBannerError('')
    setProfileSaved(false)
    try {
      setBannerImage(await fileToBannerDataUrl(file))
      setBannerMode('gif')
    } catch (err) {
      setBannerError((err as Error).message)
    }
  }

  const handleSaveProfile = async () => {
    if (bio.length > BIO_MAX_LENGTH) {
      setProfileError(`Слишком длинное описание (максимум ${BIO_MAX_LENGTH} символов).`)
      return
    }
    setSavingProfile(true)
    setProfileError('')
    setProfileSaved(false)
    try {
      const patch: {
        display_name?: string
        bio?: string
        avatar_image?: string
        banner_gradient?: string
        banner_image?: string
      } = {}
      if (displayName.trim() !== (user.display_name || '')) patch.display_name = displayName.trim()
      if (bio.trim() !== (user.bio || '')) patch.bio = bio.trim()
      if (avatarImage !== user.avatar_image) patch.avatar_image = avatarImage
      if (bannerDirty) {
        patch.banner_gradient = desiredGradient
        patch.banner_image = desiredBannerImage
      }
      const updated = await api.updateProfile(patch)
      updateLocalUser(updated)
      setProfileSaved(true)
    } catch (err) {
      setProfileError((err as Error).message)
    } finally {
      setSavingProfile(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Мой профиль</h2>

        <div className="profile-avatar-row">
          <button
            type="button"
            className="profile-avatar-edit"
            onClick={() => fileRef.current?.click()}
            title="Сменить аватар"
          >
            <Avatar name={user.username} color={user.avatar_color} image={avatarImage} size={80} />
            <span className="profile-avatar-overlay">
              <Camera size={20} />
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="profile-file-input"
            onChange={handleFileChange}
          />
          {avatarImage && (
            <button
              type="button"
              className="profile-avatar-remove"
              onClick={() => {
                setAvatarImage('')
                setProfileSaved(false)
              }}
            >
              <Trash2 size={13} /> Удалить аватар
            </button>
          )}
        </div>

        <div className="field-label">Фон карточки профиля</div>
        <div
          className="banner-preview"
          style={{ background: bannerMode === 'gif' && bannerImage ? undefined : currentGradientCss }}
        >
          {bannerMode === 'gif' && bannerImage && (
            <img src={bannerImage} alt="" className="banner-preview-img" />
          )}
        </div>

        <div className="banner-mode-tabs">
          <button
            type="button"
            className={`banner-mode-tab ${bannerMode === 'gradient' ? 'active' : ''}`}
            onClick={() => {
              setBannerMode('gradient')
              setProfileSaved(false)
            }}
          >
            Градиент
          </button>
          <button
            type="button"
            className={`banner-mode-tab ${bannerMode === 'gif' ? 'active' : ''}`}
            onClick={() => {
              setBannerMode('gif')
              setProfileSaved(false)
            }}
          >
            Гифка
          </button>
        </div>

        {bannerMode === 'gradient' ? (
          <>
            <div className="gradient-presets">
              {GRADIENT_PRESETS.map(([from, to]) => (
                <button
                  key={from + to}
                  type="button"
                  className="gradient-preset"
                  style={{ background: buildGradient(gradientAngle, from, to) }}
                  title="Применить пресет"
                  onClick={() => {
                    setGradientFrom(from)
                    setGradientTo(to)
                    setProfileSaved(false)
                  }}
                />
              ))}
            </div>
            <div className="gradient-controls">
              <label className="gradient-color-field">
                От
                <input
                  type="color"
                  value={gradientFrom}
                  onChange={(e) => {
                    setGradientFrom(e.target.value)
                    setProfileSaved(false)
                  }}
                />
              </label>
              <label className="gradient-color-field">
                До
                <input
                  type="color"
                  value={gradientTo}
                  onChange={(e) => {
                    setGradientTo(e.target.value)
                    setProfileSaved(false)
                  }}
                />
              </label>
              <label className="gradient-angle-field">
                Угол
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={gradientAngle}
                  onChange={(e) => {
                    setGradientAngle(Number(e.target.value))
                    setProfileSaved(false)
                  }}
                />
              </label>
            </div>
          </>
        ) : (
          <div className="banner-gif-row">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => bannerFileRef.current?.click()}
            >
              {bannerImage ? 'Заменить гифку' : 'Загрузить гифку'}
            </button>
            <input
              ref={bannerFileRef}
              type="file"
              accept="image/gif,image/webp,image/png,image/jpeg"
              className="profile-file-input"
              onChange={handleBannerFileChange}
            />
            {bannerImage && (
              <button
                type="button"
                className="profile-avatar-remove"
                onClick={() => {
                  setBannerImage('')
                  setProfileSaved(false)
                }}
              >
                <Trash2 size={13} /> Убрать
              </button>
            )}
            <span className="banner-hint">
              До {BANNER_MAX_W}×{BANNER_MAX_H}, макс. {Math.round(BANNER_MAX_BYTES / 1_000_000)} МБ.
            </span>
          </div>
        )}
        {bannerError && <div className="login-error">{bannerError}</div>}

        <div className="field-label">Отображаемое имя</div>
        <input
          className="field-input"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value)
            setProfileSaved(false)
          }}
          placeholder={user.username}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
        />

        <div className="field-label">О себе</div>
        <textarea
          className="field-input profile-bio-input"
          value={bio}
          onChange={(e) => {
            setBio(e.target.value)
            setProfileSaved(false)
          }}
          placeholder="Расскажи о себе"
          maxLength={BIO_MAX_LENGTH}
          rows={3}
        />

        {profileError && <div className="login-error">{profileError}</div>}
        {profileSaved && !profileError && <div className="profile-success">Сохранено.</div>}

        <button
          className="btn-primary"
          onClick={handleSaveProfile}
          disabled={
            savingProfile || !profileDirty
          }
        >
          {savingProfile ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
        </button>

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
