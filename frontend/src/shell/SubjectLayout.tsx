import { NavLink, Outlet, useParams } from 'react-router'
import { describeError } from '../api/client'
import { lastChatNode } from '../lib/lastChat'
import { SubjectProvider } from '../state/subject'
import { useSubject } from '../state/context'

export function SubjectLayout() {
  const { subjectId } = useParams()
  const id = Number(subjectId)
  return (
    <SubjectProvider key={id} subjectId={id}>
      <SubjectFrame />
    </SubjectProvider>
  )
}

function SubjectFrame() {
  const { graph, graphError, status, subjectId } = useSubject()
  if (graphError) return <p className="error-banner page-pad">{describeError(graphError)}</p>
  if (!graph) return <p className="muted page-pad">Loading…</p>
  const chatNode = lastChatNode.get(subjectId) ?? graph.subject.origin_node_id
  return (
    <div className="subject">
      <header className="topbar">
        <h1 className="topbar-title">{graph.subject.title}</h1>
        <div className="segmented" role="tablist" aria-label="Screen">
          <NavLink to={`/s/${subjectId}/chat/${chatNode}`} className="segment">
            Chat
          </NavLink>
          <NavLink to={`/s/${subjectId}/graph`} className="segment">
            Graph
          </NavLink>
        </div>
        <CartographerChip state={status?.cartographer} error={status?.error ?? null} />
      </header>
      <div className="subject-body">
        <Outlet />
      </div>
    </div>
  )
}

function CartographerChip({ state, error }: { state?: string; error: string | null }) {
  if (state === 'running') return <span className="chip">Updating map…</span>
  if (state === 'error')
    return (
      <span className="chip chip-error" title={error ?? undefined}>
        Map update failed; the next message catches up
      </span>
    )
  return <span className="chip chip-quiet">Map up to date</span>
}
