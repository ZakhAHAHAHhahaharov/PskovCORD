import { EffectiveStatus } from '../api'
import { useAvatarAnimation } from '../avatarAnim'
import { useUserStatus } from '../presence'

type StatusDot = EffectiveStatus | 'invisible'

export default function Avatar({
  name,
  color,
  image,
  size = 32,
  online,
  status,
  showStatus = false,
  speaking = false,
  userId,
  animated = false,
  playAnimation = false,
}: {
  name: string
  color: string
  /** Картинка аватара (data-URL). Пусто/undefined — цветной кружок с буквой.
   * У анимированного аватара это выбранный владельцем кадр гифки — то, что
   * видно, пока анимация не играет. */
  image?: string
  size?: number
  /** Устаревший способ (только online/offline) — используется, если `status` не задан. */
  online?: boolean
  /** Точный статус (online/dnd/offline/invisible). Не задан — при showStatus
   * берётся из общего стора по userId (см. presence.ts): в списке друзей,
   * диалогов и пикерах строке взять статус больше неоткуда, а ростер сервера
   * (MembersList) наоборот передаёт его явно, вместе со своим списком. */
  status?: StatusDot
  showStatus?: boolean
  speaking?: boolean
  /** Чей это аватар — нужен, чтобы догрузить гифку (см. avatarAnim.ts).
   * Без него анимация не проигрывается, даже если animated=true. */
  userId?: number
  /** У аватара есть гифка (User.avatar_animated). */
  animated?: boolean
  /** Проигрывать ли её ПРЯМО СЕЙЧАС. Правила везде разные и живут в
   * вызывающих: говорит в голосовом (speaking), навели на отправителя в
   * чате (hover), карточка профиля (всегда). Отдельный проп, а не
   * вычисление внутри: аватар не знает, в каком он контексте. */
  playAnimation?: boolean
}) {
  const initial = (name || '?').charAt(0).toUpperCase()
  // Подписка на стор — всегда (хук нельзя звать условно), но она бесплатна,
  // когда userId нет, и не участвует в dotStatus, если статус передали явно.
  const storedStatus = useUserStatus(userId)
  const dotStatus: StatusDot =
    status ?? (online !== undefined ? (online ? 'online' : 'offline') : storedStatus)
  // Пока гифка не приехала (или её нет), src — статичный кадр: подмена
  // происходит уже готовой картинкой, без пустого места между ними.
  const animation = useAvatarAnimation(userId, animated, playAnimation)
  const src = animation ?? image
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      {src ? (
        <img
          src={src}
          alt=""
          className={`avatar avatar-img ${speaking ? 'speaking' : ''}`}
          style={{ width: size, height: size }}
          // Гифка и статичный кадр — разные <img> для браузера: без смены
          // key он переиспользует элемент и может оставить на экране кадр
          // предыдущей картинки до декодирования новой. Ключ — сам src, а не
          // «анимация/статика»: у каждого включения анимации свой object-URL
          // (см. avatarAnim.ts), и новый элемент гарантирует старт с первого
          // кадра, а не продолжение прошлого показа.
          key={animation ?? 'static'}
        />
      ) : (
        <div
          className={`avatar ${speaking ? 'speaking' : ''}`}
          style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
        >
          {initial}
        </div>
      )}
      {showStatus && <span className={`status-dot ${dotStatus}`} />}
    </div>
  )
}
