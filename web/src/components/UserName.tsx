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
 * Пара «никнейм + подпись» часто не влезает в строку сайдбара — тогда она
 * едет бегущей строкой (см. ScrollingText), а не обрезается многоточием:
 * обрезка съела бы ровно ту подпись, ради которой всё и затевалось.
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

  const content = (
    <>
      <span className={`${className} ${styled.className}`} style={styled.style}>
        {name}
      </span>
      {nickname && <span className="user-name-original">{user.username}*</span>}
    </>
  )

  if (noScroll || !nickname) {
    return <span className="user-name">{content}</span>
  }
  return (
    <ScrollingText className="user-name" measureKey={`${name}|${user.username}`}>
      {content}
    </ScrollingText>
  )
}
