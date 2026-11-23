import { useEffect, useRef, useState } from 'react'
import { describeError } from '../api/client'
import type { CanvasNode } from '../api/types'
import { Composer } from '../chat/Composer'
import { Markdown } from '../chat/Markdown'
import { MessageView } from '../chat/MessageView'
import { useStreams } from '../state/streams-context'
import { nodeLabel } from './labels'

/** A node's full conversation in the side panel ("Open" on a card). */
export function ConversationPanel({
  subjectId,
  node,
  onClose,
}: {
  subjectId: number
  node: CanvasNode
  onClose: () => void
}) {
  const streams = useStreams()
  const live = streams.live.get(node.id)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const streaming = Boolean(live?.running || node.streaming)

  useEffect(() => {
    if (streaming && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [streaming, live?.text])

  const last = node.messages[node.messages.length - 1]
  const liveQuestion =
    live?.running && live.question && !(last?.role === 'user' && last.content === live.question)
      ? live.question
      : null

  return (
    <aside className="side-panel" aria-label="Conversation">
      <header className="side-panel-head">
        <h2 className="side-panel-title">{nodeLabel(node)}</h2>
        <button type="button" className="icon-button" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="side-panel-body" ref={scroller}>
        {node.kind === 'note' ? (
          <Markdown text={node.note_body} />
        ) : (
          <div className="thread-inner">
            {node.messages.map((m) => (
              <MessageView key={m.id} message={m} context={streams.contexts.get(m.id)} />
            ))}
            {liveQuestion && (
              <div className="msg msg-user">
                <div className="bubble">{liveQuestion}</div>
              </div>
            )}
            {live?.running && live.text && (
              <div className="msg msg-assistant">
                <Markdown text={live.text} />
              </div>
            )}
            {live?.error && <p className="error-banner">{describeError(live.error)}</p>}
          </div>
        )}
      </div>
      {node.kind === 'chat' && (
        <div className="side-panel-foot">
          {streaming ? (
            <button type="button" className="button" disabled={live?.stopping} onClick={() => void streams.stop(node.id)}>
              {live?.stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : node.pending ? (
            <button
              type="button"
              className="button primary"
              onClick={() => void streams.ask(subjectId, node.id, null)}
            >
              Answer
            </button>
          ) : (
            <Composer
              text={draft}
              onChange={setDraft}
              disabled={streaming}
              placeholder="Follow up…"
              onSend={(t) => void streams.ask(subjectId, node.id, t)}
            />
          )}
        </div>
      )}
    </aside>
  )
}
