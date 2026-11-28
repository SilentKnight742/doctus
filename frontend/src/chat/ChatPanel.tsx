import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, describeError } from '../api/client'
import type { ChatScope, MessagePart } from '../api/types'
import { Composer } from './Composer'
import { MessageView, Parts } from './MessageView'

const keyOf = (s: ChatScope) => `${s.kind}:${s.id}`

/** The space or world chat, with the (scripted) agent behind it. */
export function ChatPanel({ scope, intro }: { scope: ChatScope; intro: string }) {
  const qc = useQueryClient()
  const key = keyOf(scope)
  const messages = useQuery({ queryKey: ['messages', key], queryFn: () => api.messages(scope) })
  const suggestions = useQuery({ queryKey: ['suggestions', key], queryFn: () => api.suggestions(scope) })
  const [text, setText] = useState('')
  const [live, setLive] = useState<MessagePart[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)

  const count = messages.data?.length ?? 0
  const liveLen = live?.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 40), 0) ?? 0
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [count, liveLen])

  // A reply in progress keeps running if the panel goes away, as it would on
  // a server; its message appears when it ends.

  async function send(message: string) {
    if (live) return
    setError(null)
    setLive([])
    const c = new AbortController()
    ctrl.current = c
    const push = (p: MessagePart) =>
      setLive((parts) => {
        const out = [...(parts ?? [])]
        const last = out[out.length - 1]
        if (p.type === 'text' && last?.type === 'text') out[out.length - 1] = { ...last, text: last.text + p.text }
        else out.push(p)
        return out
      })
    try {
      await api.chat(scope, message, {
        signal: c.signal,
        onText: (t) => push({ type: 'text', text: t }),
        onTool: (p) => push(p),
      })
    } catch (e) {
      setError(describeError(e))
    } finally {
      await qc.invalidateQueries({ queryKey: ['messages', key] })
      setLive(null)
      ctrl.current = null
    }
  }

  return (
    <div className="chat">
      <div className="chat-body">
        {count === 0 && !live && <p className="muted small chat-intro">{intro}</p>}
        {messages.data?.map((m) => <MessageView key={m.id} message={m} />)}
        {live && (
          <div className="msg msg-assistant is-live">
            <Parts parts={live} />
            <span className="typing" aria-label="Agent is working">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="chat-foot">
        {error && <p className="form-error">{error}</p>}
        {!live && (suggestions.data?.length ?? 0) > 0 && (
          <div className="prompt-chips" aria-label="Suggested prompts">
            {suggestions.data!.map((s) => (
              <button key={s.id} type="button" className="prompt-chip" onClick={() => send(s.label)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
        {live ? (
          <div className="chat-running">
            <span className="muted small">Agent working…</span>
            <button type="button" className="button small-button" onClick={() => ctrl.current?.abort()}>
              Stop
            </button>
          </div>
        ) : (
          <Composer text={text} onChange={setText} disabled={false} placeholder="Message the agent…" onSend={send} />
        )}
      </div>
    </div>
  )
}
