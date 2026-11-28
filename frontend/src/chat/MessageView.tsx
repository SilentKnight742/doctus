import type { ChatMessage, MessagePart } from '../api/types'
import { Markdown } from './Markdown'

export function Parts({ parts }: { parts: MessagePart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <Markdown key={i} text={p.text} />
        ) : (
          <div key={i} className="tool-line" data-ok={p.ok}>
            <span className="tool-mark" aria-hidden>
              {p.ok ? '✓' : '!'}
            </span>
            <span className="tool-name">{p.tool}</span>
            <span className="tool-summary">{p.summary}</span>
          </div>
        ),
      )}
    </>
  )
}

export function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="msg msg-user">
        {message.from_space_agent && <span className="msg-from small muted">From the space agent</span>}
        <div className="bubble">{text}</div>
      </div>
    )
  }
  return (
    <div className="msg msg-assistant">
      <Parts parts={message.parts} />
      {message.stopped && <span className="muted small">Stopped</span>}
    </div>
  )
}
