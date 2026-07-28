import { useRef, useState, ChangeEvent } from 'react'
import { Camera, Trash2, Loader2 } from 'lucide-react'
import { useAuth } from '../auth'
import { api, DmPrivacy } from '../api'
import { useEscToClose } from '../modalStack'
import {
  AVATAR_SIZE, BANNER_MAX_BYTES, BANNER_MAX_H, BANNER_MAX_W, GRADIENT_PRESETS,
  buildGradient, fileToBannerDataUrl, fileToSquareDataUrl, parseGradient,
} from '../images'
import Avatar from './Avatar'

const DM_PRIVACY_LABELS: Record<DmPrivacy, string> = {
  friends: 'Только друзья',
  nobody: 'Никто',
  everyone: 'Любой зарегистрированный',
}

/**
 * Профиль пользователя — всплывает поверх страницы (как в Discord). Смена
 * ника, аватара (сжимается на клиенте до 256x256, хранится как data-URL в
 * БД — см. accounts.models.User.avatar_image) и пароля (с проверкой знания
 * текущего). Открывается из ChannelSidebar (иконка в user-panel-actions).
 */
export default function ProfileModal({ onClose }: { onClose: () => void }) {
  useEscToClose(onClose)
  const { user, updateLocalUser } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  const [username, setUsername] = useState(user?.username ?? '')
  // Отдельно от полей "Смена пароля" ниже — это подтверждение личности для
  // смены НИКА (см. backend ProfileUpdateSerializer.validate), не смена
  // самого пароля. Общее поле легко перепутать: ввёл пароль в одном месте —
  // решил, что он же годится и для другого.
  const [usernameConfirmPassword, setUsernameConfirmPassword] = useState('')
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

  const [dmPrivacy, setDmPrivacy] = useState<DmPrivacy>(user?.dm_privacy ?? 'everyone')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSaved, setPasswordSaved] = useState(false)

  if (!user) return null

  const currentGradientCss = buildGradient(gradientAngle, gradientFrom, gradientTo)
  const desiredGradient = bannerMode === 'gradient' ? currentGradientCss : ''
  const desiredBannerImage = bannerMode === 'gif' ? bannerImage : ''
  const bannerDirty =
    desiredGradient !== (user.banner_gradient || '') ||
    desiredBannerImage !== (user.banner_image || '')

  const profileDirty =
    username.trim() !== user.username ||
    avatarImage !== user.avatar_image ||
    bannerDirty ||
    dmPrivacy !== user.dm_privacy

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

  const usernameDirty = username.trim() !== user.username

  const handleSaveProfile = async () => {
    const trimmed = username.trim()
    if (!trimmed) {
      setProfileError('Ник не может быть пустым.')
      return
    }
    if (usernameDirty && !usernameConfirmPassword) {
      setProfileError('Для смены имени пользователя введите текущий пароль.')
      return
    }
    setSavingProfile(true)
    setProfileError('')
    setProfileSaved(false)
    try {
      const patch: {
        username?: string
        current_password?: string
        avatar_image?: string
        banner_gradient?: string
        banner_image?: string
        dm_privacy?: DmPrivacy
      } = {}
      if (usernameDirty) {
        patch.username = trimmed
        patch.current_password = usernameConfirmPassword
      }
      if (avatarImage !== user.avatar_image) patch.avatar_image = avatarImage
      if (bannerDirty) {
        patch.banner_gradient = desiredGradient
        patch.banner_image = desiredBannerImage
      }
      if (dmPrivacy !== user.dm_privacy) patch.dm_privacy = dmPrivacy
      const updated = await api.updateProfile(patch)
      updateLocalUser(updated)
      setProfileSaved(true)
      setUsernameConfirmPassword('')
    } catch (err) {
      setProfileError((err as Error).message)
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async () => {
    setPasswordError('')
    setPasswordSaved(false)
    if (newPassword.length < 4) {
      setPasswordError('Новый пароль должен быть не короче 4 символов.')
      return
    }
    if (newPassword !== newPassword2) {
      setPasswordError('Пароли не совпадают.')
      return
    }
    setSavingPassword(true)
    try {
      await api.changePassword(currentPassword, newPassword)
      setPasswordSaved(true)
      setCurrentPassword('')
      setNewPassword('')
      setNewPassword2('')
    } catch (err) {
      setPasswordError((err as Error).message)
    } finally {
      setSavingPassword(false)
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
            <Avatar name={username || user.username} color={user.avatar_color} image={avatarImage} size={80} />
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

        <div className="field-label">Никнейм</div>
        <input
          className="field-input"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value)
            setProfileSaved(false)
          }}
          maxLength={150}
        />
        {usernameDirty && (
          <>
            <div className="field-label">Текущий пароль — подтвердите смену имени</div>
            <input
              className="field-input"
              type="password"
              autoComplete="current-password"
              value={usernameConfirmPassword}
              onChange={(e) => {
                setUsernameConfirmPassword(e.target.value)
                setProfileSaved(false)
              }}
            />
          </>
        )}

        <div className="field-label">Кто может мне писать личные сообщения</div>
        <select
          className="field-input"
          value={dmPrivacy}
          onChange={(e) => {
            setDmPrivacy(e.target.value as DmPrivacy)
            setProfileSaved(false)
          }}
        >
          {(Object.keys(DM_PRIVACY_LABELS) as DmPrivacy[]).map((value) => (
            <option key={value} value={value}>
              {DM_PRIVACY_LABELS[value]}
            </option>
          ))}
        </select>

        {profileError && <div className="login-error">{profileError}</div>}
        {profileSaved && !profileError && <div className="profile-success">Сохранено.</div>}

        <button
          className="btn-primary"
          onClick={handleSaveProfile}
          disabled={
            savingProfile || !profileDirty || (usernameDirty && !usernameConfirmPassword)
          }
        >
          {savingProfile ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
        </button>

        <div className="profile-divider" />

        <h3 className="profile-subtitle">Смена пароля</h3>

        <div className="field-label">Текущий пароль</div>
        <input
          className="field-input"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <div className="field-label">Новый пароль</div>
        <input
          className="field-input"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <div className="field-label">Повторите новый пароль</div>
        <input
          className="field-input"
          type="password"
          autoComplete="new-password"
          value={newPassword2}
          onChange={(e) => setNewPassword2(e.target.value)}
        />

        {passwordError && <div className="login-error">{passwordError}</div>}
        {passwordSaved && !passwordError && (
          <div className="profile-success">Пароль изменён.</div>
        )}

        <button
          className="btn-primary"
          onClick={handleChangePassword}
          disabled={savingPassword || !currentPassword || !newPassword}
        >
          {savingPassword ? <Loader2 size={15} className="spin" /> : 'Сменить пароль'}
        </button>

        <button className="modal-close" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  )
}
