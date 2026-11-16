import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ChatThread } from '../chat/ChatThread'
import { NodeDetail } from '../chat/NodeDetail'
import { GraphCanvas } from '../graph/GraphCanvas'
import { Breadcrumb } from '../shell/Breadcrumb'
import { lastChatNode } from '../lib/lastChat'
import { useSubject } from '../state/context'

export function ChatScreen() {
  const { nodeId } = useParams()
  const id = Number(nodeId)
  const nav = useNavigate()
  const { subjectId, nodesById, openFrom } = useSubject()
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    lastChatNode.set(subjectId, id)
  }, [subjectId, id])

  const open = (target: number) => {
    openFrom(target, id)
    nav(`/s/${subjectId}/chat/${target}`)
  }

  return (
    <div className={`chat-screen ${drawer ? 'has-drawer' : ''}`}>
      <div className="chat-main">
        <div className="chat-head">
          <Breadcrumb currentId={id} onOpen={open} />
          <button type="button" className="button ghost" onClick={() => setDrawer((v) => !v)} aria-expanded={drawer}>
            {drawer ? 'Hide details' : 'Details'}
          </button>
        </div>
        <ChatThread key={id} nodeId={id} />
      </div>
      {drawer && (
        <aside className="drawer" aria-label="Topic details">
          <h3>{nodesById.get(id)?.name}</h3>
          <NodeDetail nodeId={id} onOpen={open} />
        </aside>
      )}
      <div
        role="button"
        tabIndex={0}
        className="mini-graph"
        aria-label="Open the graph"
        onClick={() => nav(`/s/${subjectId}/graph?open=${id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') nav(`/s/${subjectId}/graph?open=${id}`)
        }}
      >
        <GraphCanvas currentId={id} mini />
      </div>
    </div>
  )
}
