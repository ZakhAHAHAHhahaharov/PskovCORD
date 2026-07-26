import { useEffect, useState } from 'react'
import { Gavel, ThumbsDown, ThumbsUp } from 'lucide-react'

export interface MuteVoteInfo {
  channelId: number
  targetUserId: number
  targetUsername: string
  /** unix-секунды окончания голосования (см. chat.consumers.voice_mute_vote_start). */
  endsAt: number
}

/**
 * Голосование «Заглушить ИМЯ?», запущенное кем-то из участников голосового
 * канала (см. ParticipantContextMenu → AppShell.handleStartMuteVote) —
 * плашка поверх всего, как IncomingCallBanner, показывается ВСЕМ участникам
 * канала, кроме самой цели голосования (см. AppShell — там же гейт). Сама не
 * закрывается по клику вне себя: закрывается, когда мы проголосовали (см.
 * AppShell.handleCastMuteVote) или пришёл итог voice_mute_vote_result.
 */
export default function MuteVoteModal({
  vote,
  onCastVote,
}: {
  vote: MuteVoteInfo
  onCastVote: (forMute: boolean) => void
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  const secondsLeft = Math.max(0, Math.ceil(vote.endsAt - now / 1000))

  return (
    <div className="mute-vote-modal">
      <div className="mute-vote-modal-header">
        <Gavel size={18} /> Заглушить {vote.targetUsername}?
      </div>
      <div className="mute-vote-modal-timer">Осталось {secondsLeft} с</div>
      <div className="mute-vote-modal-actions">
        <button type="button" className="mute-vote-btn for" onClick={() => onCastVote(true)}>
          <ThumbsUp size={16} /> ЗА
        </button>
        <button type="button" className="mute-vote-btn against" onClick={() => onCastVote(false)}>
          <ThumbsDown size={16} /> ПРОТИВ
        </button>
      </div>
    </div>
  )
}
