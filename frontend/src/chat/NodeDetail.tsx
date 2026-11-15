import type { GraphEdge } from '../api/types'
import { useNode } from '../hooks/chat'
import { useSubject } from '../state/context'

function relation(e: GraphEdge, self: number): string {
  const out = e.source === self
  switch (e.kind) {
    case 'prerequisite':
      return out ? 'Needed for' : 'Builds on'
    case 'part_of':
      return out ? 'Part of' : 'Has part'
    default:
      return 'Related to'
  }
}

/** Summary, evidence quotes and edges for one node. */
export function NodeDetail({ nodeId, onOpen }: { nodeId: number; onOpen: (id: number) => void }) {
  const { nodesById, graph } = useSubject()
  const q = useNode(nodeId)
  if (!q.data) return <p className="muted">Loading…</p>
  const { node, evidence, edges } = q.data
  const isOrigin = graph?.subject.origin_node_id === nodeId
  return (
    <div className="node-detail">
      {node.summary ? <p>{node.summary}</p> : <p className="muted">No summary yet.</p>}
      <h4>Evidence</h4>
      {evidence.length === 0 ? (
        <p className="muted">{isOrigin ? 'The origin needs no evidence.' : 'None.'}</p>
      ) : (
        <ul className="evidence">
          {evidence.map((e, i) => (
            <li key={`${e.message_id}-${i}`}>
              <blockquote>{e.quote}</blockquote>
            </li>
          ))}
        </ul>
      )}
      <h4>Connections</h4>
      {edges.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="edge-list">
          {edges.map((e) => {
            const other = e.source === nodeId ? e.target : e.source
            return (
              <li key={e.id}>
                <span className={`edge-kind edge-kind-${e.kind}`}>{relation(e, nodeId)}</span>{' '}
                <button type="button" className="link-button" onClick={() => onOpen(other)}>
                  {nodesById.get(other)?.name ?? `#${other}`}
                </button>
                {e.reason && <div className="muted small">{e.reason}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
