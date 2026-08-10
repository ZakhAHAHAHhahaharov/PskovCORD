import { BarChart3, Check, Lock } from 'lucide-react'
import { Poll } from '../api'
import { useGateway } from '../gateway'

/**
 * Опрос в ленте: вопрос, варианты с долями и свой голос.
 *
 * Результаты видны всегда, а не только после голоса — как в Discord. Прятать
 * их до участия значит заставлять голосовать ради того, чтобы посмотреть, а
 * это портит сам опрос: люди жмут что попало.
 */
export default function PollCard({
  poll,
  selfId,
  /** Можно ли закрыть опрос досрочно: автор сообщения или модерация
   * сообщений. Решает вызывающий — здесь нет ни того, ни другого контекста. */
  canClose,
}: {
  poll: Poll
  selfId: number
  canClose: boolean
}) {
  const gateway = useGateway()
  const myOptionIds = poll.options
    .filter((o) => o.voter_ids.includes(selfId))
    .map((o) => o.id)

  // Знаменатель: при multiple один человек отмечает несколько вариантов, и
  // делить на число голосов бессмысленно — сумма долей ушла бы в потолок при
  // трёх проголосовавших (см. backend serializers.poll_payload).
  const denominator = poll.multiple ? poll.total_voters : poll.total_votes

  const vote = (optionId: number) => {
    if (!poll.open) return
    const mine = myOptionIds.includes(optionId)
    if (poll.multiple) {
      // Отметить/снять, не трогая остальные свои голоса.
      const next = mine
        ? myOptionIds.filter((id) => id !== optionId)
        : [...myOptionIds, optionId]
      gateway.pollVote(poll.id, next)
      return
    }
    // Повторный клик по уже выбранному — снять голос: иначе передумать и
    // «не голосовать вовсе» было бы невозможно.
    gateway.pollVote(poll.id, mine ? [] : [optionId])
  }

  return (
    <div className={`poll-card ${poll.open ? '' : 'poll-closed'}`}>
      <div className="poll-question">{poll.question}</div>
      <div className="poll-meta">
        <BarChart3 size={12} />
        {poll.multiple ? 'Несколько вариантов' : 'Один вариант'}
        {' · '}
        {poll.total_voters === 0
          ? 'ещё никто не голосовал'
          : `проголосовало: ${poll.total_voters}`}
        {!poll.open && (
          <>
            {' · '}
            <Lock size={12} /> завершён
          </>
        )}
      </div>

      <div className="poll-options">
        {poll.options.map((option) => {
          const mine = myOptionIds.includes(option.id)
          const percent = denominator > 0
            ? Math.round((option.votes / denominator) * 100)
            : 0
          return (
            <button
              key={option.id}
              type="button"
              className={`poll-option ${mine ? 'mine' : ''}`}
              disabled={!poll.open}
              onClick={() => vote(option.id)}
              title={poll.open ? undefined : 'Опрос завершён'}
            >
              {/* Заливка доли — отдельным слоем под текстом, а не фоном
                  кнопки: иначе процент пришлось бы красить градиентом, и
                  граница заливки скакала бы по субпикселям при анимации. */}
              <span className="poll-option-fill" style={{ width: `${percent}%` }} />
              <span className="poll-option-body">
                <span className={`poll-option-check ${mine ? 'checked' : ''}`}>
                  {mine && <Check size={12} />}
                </span>
                <span className="poll-option-text">{option.text}</span>
                <span className="poll-option-count">
                  {option.votes} · {percent}%
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {canClose && poll.open && (
        <button
          type="button"
          className="poll-close-btn"
          onClick={() => gateway.pollClose(poll.id)}
        >
          Завершить опрос
        </button>
      )}
    </div>
  )
}
