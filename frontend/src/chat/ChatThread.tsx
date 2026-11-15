import { useEffect, useRef, useState } from 'react'
import { describeError, RateLimited } from '../api/client'
import { useNode, useSendMessage } from '../hooks/chat'
import { useSubject } from '../state/context'
import { Composer } from './Composer'
import { MessageView } from './MessageView'

/** Messages plus composer for one node. Used by the chat screen and the window. */
export function ChatThread({ nodeId, compact = false }: { nodeId: number; compact?: boolean }) {
  const { graph, draft, setDraft, contextFor } = useSubject()
  const nodeQ = useNode(nodeId)
  const send = useSendMessage(nodeId)
  const [text, setTextState] = useState(() => draft(nodeId))
  const setText = (t: string) => {
    setTextState(t)
    setDraft(nodeId, t)
  }
  const [lastSent, setLastSent] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const messages = nodeQ.data?.messages ?? []
  const isOrigin = graph?.subject.origin_node_id === nodeId
  const nodeName = nodeQ.data?.node.name ?? ''

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, send.isPending])

  const submit = (text: string) => {
    setLastSent(text)
    send.mutate(text, {
      // Put the text back so nothing typed is lost.
      onError: () => setText(text),
    })
  }

  return (
    <div className={`thread ${compact ? 'thread-compact' : ''}`}>
      <div className="thread-scroll" ref={scroller}>
        <div className="thread-inner">
          {nodeQ.isLoading && <p className="muted">Loading…</p>}
          {nodeQ.error && <p className="error-banner">{describeError(nodeQ.error)}</p>}
          {nodeQ.data && messages.length === 0 && !send.isPending && (
            <div className="empty-thread">
              <p className="empty-title">{isOrigin ? graph?.subject.title : nodeName}</p>
              <p className="muted">
                {isOrigin
                  ? 'Ask anything to begin. The map fills in as you talk.'
                  : 'Ask about this topic, or pick up where you left off.'}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} context={contextFor(m.id)} />
          ))}
          {send.isPending && lastSent && (
            <>
              <MessageView message={{ id: -1, role: 'user', content: lastSent, created_at: 0 }} />
              <div className="msg msg-assistant">
                <span className="typing" aria-label="Waiting for reply">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </>
          )}
          {send.error && !send.isPending && (
            <div className="error-banner" role="alert">
              <span>{describeError(send.error)}</span>
              {!(send.error instanceof RateLimited) && lastSent && (
                <button type="button" className="link-button" onClick={() => submit(lastSent)}>
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="thread-composer">
        <Composer
          text={text}
          onChange={setText}
          disabled={send.isPending}
          placeholder={isOrigin && messages.length === 0 ? 'What do you want to learn?' : 'Message'}
          onSend={submit}
          autoFocus
        />
        {!compact && <p className="hint muted">Enter to send · Shift+Enter for a new line</p>}
      </div>
    </div>
  )
}
