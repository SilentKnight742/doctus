import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'

interface Props {
  text: string
  onChange: (text: string) => void
  disabled: boolean
  placeholder: string
  onSend: (text: string) => void
  autoFocus?: boolean
}

export function Composer({ text, onChange, disabled, placeholder, onSend, autoFocus }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const send = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    onChange('')
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
      />
      <button type="submit" className="button primary" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  )
}
