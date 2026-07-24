import { useRef, useState, ChangeEvent } from 'react'
import { Camera, Trash2, Loader2 } from 'lucide-react'
import { useAuth } from '../auth'
import { api } from '../api'
import Avatar from './Avatar'

/** Сторона квадрата, до которого сжимается аватар перед отправкой — держит
 * data-URL небольшим (десятки КБ): он летит в каждой строке ростера/сообщении
 * и рассылается всем через WS при смене. */
const AVATAR_SIZE = 256

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

  const [username, setUsername] = useState(user?.username ?? '')
  const [avatarImage, setAvatarImage] = useState(user?.avatar_image ?? '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileSaved, setProfileSaved] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSaved, setPasswordSaved] = useState(false)

  if (!user) return null

  const profileDirty =
    username.trim() !== user.username || avatarImage !== user.avatar_image

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
      const patch: { username?: string; avatar_image?: string } = {}
      if (trimmed !== user.username) patch.username = trimmed
      if (avatarImage !== user.avatar_image) patch.avatar_image = avatarImage
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
