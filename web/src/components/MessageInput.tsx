import { useState } from 'react'

export default function MessageInput({
  channelName,
  onSend,
}: {
  channelName: string
  onSend: (content: string) => void
}) {
  const [value, setValue] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const content = value.trim()
    if (!content) return
    onSend(content)
    setValue('')
  }

  return (
    <form className="message-input" onSubmit={submit}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Написать в #${channelName}`}
      />
    </form>
  )
}
