import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react'
import { floatingLine, weight } from './geometry'

export type ConnectionEdgeData = { count: number; selectedCount: number; isOpen: boolean }
export type ConnectionFlowEdge = Edge<ConnectionEdgeData, 'connection'>

/** One line per pair of worlds; its width grows with the number of reasons. */
export function ConnectionEdge({ id, source, target, data }: EdgeProps<ConnectionFlowEdge>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t || !data) return null
  const rect = (n: typeof s) => ({
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? 0,
    h: n.measured.height ?? 0,
  })
  const { sx, sy, tx, ty } = floatingLine(rect(s), rect(t))
  const path = `M ${sx},${sy} L ${tx},${ty}`
  const cls = `connection-line${data.isOpen ? ' is-open' : ''}${data.selectedCount ? ' has-selection' : ''}`
  return (
    <>
      <BaseEdge id={id} path={path} className={cls} style={{ strokeWidth: weight(data.count) }} interactionWidth={24} />
      <EdgeLabelRenderer>
        <div
          className={`connection-count${data.isOpen ? ' is-open' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${(sx + tx) / 2}px, ${(sy + ty) / 2}px)` }}
          aria-hidden
        >
          {data.count}
          {data.selectedCount > 0 && <span className="connection-selected"> · {data.selectedCount}✓</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
