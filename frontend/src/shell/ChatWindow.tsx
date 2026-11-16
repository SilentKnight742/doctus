import { useState } from 'react'
import { ChatThread } from '../chat/ChatThread'
import { NodeDetail } from '../chat/NodeDetail'
import { useSubject } from '../state/context'

interface Props {
  nodeId: number
  minimised: boolean
  onMinimise: () => void
  onClose: () => void
  onExpand: () => void
  onOpen: (id: number) => void
}

/** A floating chat for one node, docked bottom-right (like a compose window). */
export function ChatWindow({ nodeId, minimised, onMinimise, onClose, onExpand, onOpen }: Props) {
  const { nodesById } = useSubject()
  const [details, setDetails] = useState(false)
  const name = nodesById.get(nodeId)?.name ?? ''
  return (
    <section className={`chat-window ${minimised ? 'is-minimised' : ''}`} aria-label={`Chat: ${name}`}>
      <header className="chat-window-head">
        <button type="button" className="chat-window-title" onClick={onMinimise} title={name}>
          {name}
        </button>
        {!minimised && (
          <button type="button" className="icon-button" onClick={() => setDetails((v) => !v)} aria-pressed={details} title="Details">
            i
          </button>
        )}
        <button type="button" className="icon-button" onClick={onMinimise} title={minimised ? 'Restore' : 'Minimise'}>
          {minimised ? '▴' : '▾'}
        </button>
        <button type="button" className="icon-button" onClick={onExpand} title="Open in chat screen">
          ⤢
        </button>
        <button type="button" className="icon-button" onClick={onClose} title="Close">
          ×
        </button>
      </header>
      {!minimised && (
        <div className="chat-window-body">
          {details && (
            <div className="chat-window-details">
              <NodeDetail nodeId={nodeId} onOpen={onOpen} />
            </div>
          )}
          <ChatThread key={nodeId} nodeId={nodeId} compact />
        </div>
      )}
    </section>
  )
}
