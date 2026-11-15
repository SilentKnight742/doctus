import { useSubject } from '../state/context'

/** The trail: recent visits, oldest first, ending at the current node. */
export function Breadcrumb({ currentId, onOpen }: { currentId: number; onOpen: (id: number) => void }) {
  const { graph, nodesById } = useSubject()
  const steps: number[] = []
  for (const t of graph?.trail ?? []) {
    if (steps.at(-1) !== t.node_id) steps.push(t.node_id)
  }
  if (steps.at(-1) !== currentId) steps.push(currentId)
  const shown = steps.slice(-6)
  return (
    <nav className="breadcrumb" aria-label="Trail">
      {steps.length > shown.length && <span className="muted">… </span>}
      {shown.map((id, i) => {
        const last = i === shown.length - 1
        const name = nodesById.get(id)?.name ?? `#${id}`
        return (
          <span key={`${id}-${i}`} className="crumb">
            {last ? (
              <span aria-current="page">{name}</span>
            ) : (
              <button type="button" className="link-button" onClick={() => onOpen(id)}>
                {name}
              </button>
            )}
            {!last && <span className="crumb-sep">›</span>}
          </span>
        )
      })}
    </nav>
  )
}
