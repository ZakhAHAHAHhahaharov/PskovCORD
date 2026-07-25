import { useRef, useState, ChangeEvent } from 'react'
import { Camera, Trash2, Loader2 } from 'lucide-react'
import { useAuth } from '../auth'
import { api } from '../api'
import Avatar from './Avatar'

/** Сторона квадрата, до которого сжимается аватар перед отправкой — держит
 * data-URL небольшим (десятки КБ): он летит в каждой строке ростера/сообщении
 * и рассылается всем через WS при смене. */
const AVATAR_SIZE = 256

/** Максимальное разрешение и вес гифки-баннера карточки профиля. Баннер
 * гифку нельзя пережать на клиенте без потери анимации (canvas хватает
 * только первый кадр), поэтому вместо сжатия — просто валидация; лимиты
 * подобраны под реальный размер баннера в status-menu (260×130 при 86px
 * аватаре) с запасом под retina. Должны совпадать с backend (accounts/
 * serializers.py: MAX_BANNER_BYTES/ALLOWED_BANNER_MIME).
 */
const BANNER_MAX_W = 640
const BANNER_MAX_H = 320
const BANNER_MAX_BYTES = 4_000_000

const GRADIENT_PRESETS: [string, string][] = [
  ['#5865f2', '#eb459e'],
  ['#23a55a', '#5865f2'],
  ['#f0b232', '#f23f43'],
  ['#8b5cf6', '#23a55a'],
  ['#1e1f22', '#5865f2'],
]
const DEFAULT_GRADIENT_ANGLE = 135
const DEFAULT_GRADIENT: [string, string] = ['#5865f2', '#eb459e']

/** Разбирает `linear-gradient(<angle>deg, <hex> 0%, <hex> 100%)` обратно на
 * составляющие для полей редактирования; формат жёстко совпадает с тем, что
 * строит buildGradient (и с чем валидирует backend — см. GRADIENT_RE). */
function parseGradient(css: string): { angle: number; from: string; to: string } {
  const m = /^linear-gradient\((\d{1,3})deg, (#[0-9a-fA-F]{6}) 0%, (#[0-9a-fA-F]{6}) 100%\)$/.exec(
    css,
  )
  if (!m) return { angle: DEFAULT_GRADIENT_ANGLE, from: DEFAULT_GRADIENT[0], to: DEFAULT_GRADIENT[1] }
  return { angle: Number(m[1]), from: m[2], to: m[3] }
}

function buildGradient(angle: number, from: string, to: string): string {
  return `linear-gradient(${angle}deg, ${from} 0%, ${to} 100%)`
}

function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('Файл не похож на картинку.'))
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.src = dataUrl
  })
}

/** Читает файл баннера как есть (без пережатия — см. комментарий у
 * BANNER_MAX_W) и проверяет вес и разрешение. */
function fileToBannerDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > BANNER_MAX_BYTES) {
      reject(new Error(`Файл слишком большой (макс. ${Math.round(BANNER_MAX_BYTES / 1_000_000)} МБ).`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.onload = async () => {
      const dataUrl = reader.result as string
      try {
        const { width, height } = await readImageSize(dataUrl)
        if (width > BANNER_MAX_W || height > BANNER_MAX_H) {
          reject(
            new Error(
              `Слишком большое разрешение — макс. ${BANNER_MAX_W}×${BANNER_MAX_H}, а тут ${width}×${height}.`,
            ),
          )
          return
        }
        resolve(dataUrl)
      } catch (err) {
        reject(err as Error)
      }
    }
    reader.readAsDataURL(file)
  })
}

/** Читает файл, кроп по центру до квадрата и сжимает в JPEG data-URL. */
function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Файл не похож на картинку.'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIZE
        canvas.height = AVATAR_SIZE
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Canvas недоступен.'))
          return
        }
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - side) / 2
        const sy = (img.naturalHeight - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Профиль пользователя — всплывает поверх страницы (как в Discord). Смена
 * ника, аватара (сжимается на клиенте до 256x256, хранится как data-URL в
 * БД — см. accounts.models.User.avatar_image) и пароля (с проверкой знания
 * текущего). Открывается из ChannelSidebar (иконка в user-panel-actions).
 */
export default function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, updateLocalUser } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  const [username, setUsername] = useState(user?.username ?? '')
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
    username.trim() !== user.username || avatarImage !== user.avatar_image || bannerDirty

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setProfileError('')
    setProfileSaved(false)
    try {
      setAvatarImage(await fileToAvatarDataUrl(file))
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
    const trimmed = username.trim()
    if (!trimmed) {
      setProfileError('Ник не может быть пустым.')
      return
    }
    setSavingProfile(true)
    setProfileError('')
    setProfileSaved(false)
    try {
      const patch: {
        username?: string
        avatar_image?: string
        banner_gradient?: string
        banner_image?: string
      } = {}
      if (trimmed !== user.username) patch.username = trimmed
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

        {profileError && <div className="login-error">{profileError}</div>}
        {profileSaved && !profileError && <div className="profile-success">Сохранено.</div>}

        <button
          className="btn-primary"
          onClick={handleSaveProfile}
          disabled={savingProfile || !profileDirty}
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
