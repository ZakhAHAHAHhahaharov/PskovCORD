/**
 * "Облачко" статуса — говорящий пузырь с хвостиком, растущий от аватарки
 * (как в референсе пользователя), а не иконка+текст в пилюле. Чисто
 * презентационный компонент без какой-либо логики редактирования — его
 * используют и ProfileCardHeader (сама карточка, хвостик направлен к
 * аватарке), и StatusEditModal (превью того, как облачко будет выглядеть).
 */
export default function StatusBubble({
  emoji,
  text,
  placeholder,
}: {
  emoji: string
  text: string
  /** Показывается вместо текста, когда text пуст — только в режиме
   * редактирования, намёк «нажми, чтобы задать статус». В режиме чтения
   * пустое облачко родитель просто не рендерит вовсе. */
  placeholder?: string
}) {
  const isEmpty = !text && !emoji
  return (
    <div className={`status-bubble ${isEmpty ? 'status-bubble-empty' : ''}`}>
      <span className="status-bubble-tail" aria-hidden="true" />
      {emoji && <span className="status-bubble-emoji">{emoji}</span>}
      <span className="status-bubble-text">{isEmpty ? placeholder : text}</span>
    </div>
  )
}
