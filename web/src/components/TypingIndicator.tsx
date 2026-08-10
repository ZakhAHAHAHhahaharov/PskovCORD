import { useTypingUsers } from '../typing'

/** Строка «…печатает» над композером.
 *
 * Высоту занимает ВСЕГДА, даже когда никто не печатает (см. .typing-indicator
 * в index.css): иначе появление строки поднимало бы ленту сообщений на свою
 * высоту, и текст прыгал бы под курсором ровно в тот момент, когда его читают.
 */
export default function TypingIndicator({
  place,
  selfId,
  resolveName,
}: {
  /** Ключ канала/диалога — channelPlace()/conversationPlace(), см. typing.ts. */
  place: string | null
  selfId: number
  /** Имя по id. undefined — человека нет в ростере (только что зашёл, ещё не
   * подгрузился): такого молча пропускаем, «кто-то печатает» не пишем. */
  resolveName: (id: number) => string | undefined
}) {
  const ids = useTypingUsers(place, selfId)
  const names = ids.map(resolveName).filter((n): n is string => !!n)

  let text = ''
  if (names.length === 1) text = `${names[0]} печатает…`
  else if (names.length === 2) text = `${names[0]} и ${names[1]} печатают…`
  else if (names.length === 3) text = `${names[0]}, ${names[1]} и ${names[2]} печатают…`
  else if (names.length > 3) text = 'Несколько человек печатают…'

  return (
    <div className="typing-indicator" aria-live="polite">
      {text && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="typing-text">{text}</span>
        </>
      )}
    </div>
  )
}
