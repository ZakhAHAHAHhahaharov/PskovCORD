import { NameStyleSource, styledNameProps } from '../nameStyle'
import { useNickname } from '../nicknames'
import ScrollingText from './ScrollingText'

export interface UserNameSource extends NameStyleSource {
  id: number
  username: string
  display_name?: string
  /** Никнейм на текущем сервере (см. Membership.nickname) — есть только у
   * Member из ростера, у остальных источников имени его просто нет. */
  server_nickname?: string
}

/**
 * Имя человека так, как его вижу Я: мой никнейм для него (см. nicknames.ts),
 * иначе его собственное display_name, иначе username. Когда никнейм задан,
 * справа идёт подпись с настоящим ником в форме `username*` — обычным
 * шрифтом, тем же, что и username в карточке профиля, а не стилем ника:
 * подпись служебная, и, надень она на себя чужие градиенты/неон, читалась бы
 * как второе имя.
 *
 * Сам никнейм (то, что я поставил) никогда не обрезается и не едет бегущей
 * строкой — это осмысленное имя, ради которого никнейм и задавали, прятать
 * его непорядок. Бегущей строкой едет только подпись `username*`, когда ей
 * не хватает места в остатке строки (см. ScrollingText): она справочная, и
 * потерять из виду её меньшая беда, чем потерять сам никнейм.
 */
export default function UserName({
  user,
  className = '',
  /** Не пускать бегущую строку — там, где имя и так в широком месте
   * (карточка профиля даёт ему целую строку). */
  noScroll = false,
}: {
  user: UserNameSource
  className?: string
  noScroll?: boolean
}) {
  const nickname = useNickname(user.id)
  const styled = styledNameProps(user)
  // Приоритет: мой приватный никнейм для этого человека → его никнейм на
  // сервере (публичный, см. Membership.nickname) → его display_name → ник.
  // Мой бьёт серверный по той же причине, по какой бьёт display_name: смысл
  // приватного никнейма ровно в том, чтобы МОЁ название побеждало.
  const name =
    nickname || user.server_nickname || user.display_name || user.username

  const original = <span className="user-name-original">{user.username}*</span>

  return (
    <span className="user-name">
      <span
        className={`user-name-primary ${className} ${styled.className}`}
        style={styled.style}
      >
        {name}
      </span>
      {nickname && (noScroll ? (
        original
      ) : (
        <ScrollingText className="user-name-original-scroll" measureKey={user.username}>
          {original}
        </ScrollingText>
      ))}
    </span>
  )
}
