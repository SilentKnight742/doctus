import { useInternalNode } from '@xyflow/react'
import type { Edge, EdgeProps, InternalNode } from '@xyflow/react'
import type { EdgeKind } from '../api/types'

export type ConceptEdgeData = { kind: EdgeKind; count: number; mini: boolean }
export type ConceptFlowEdge = Edge<ConceptEdgeData, 'concept'>

function centre(n: InternalNode) {
  const w = n.measured.width ?? 0
  const h = n.measured.height ?? 0
  const p = n.internals.positionAbsolute
  return { x: p.x + w / 2, y: p.y + h / 2, w, h }
}

/** Where the segment from the centre of `a` toward `b` leaves a's box. */
function border(a: ReturnType<typeof centre>, b: { x: number; y: number }) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return { x: a.x, y: a.y }
  const sx = a.w / 2 / Math.abs(dx || 1e-9)
  const sy = a.h / 2 / Math.abs(dy || 1e-9)
  const s = Math.min(sx, sy)
  return { x: a.x + dx * s, y: a.y + dy * s }
}

export function FloatingEdge({ id, source, target, data, markerEnd }: EdgeProps<ConceptFlowEdge>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t || !data) return null
  const a = centre(s)
  const b = centre(t)
  const p1 = border(a, b)
  const p2 = border(b, a)
  const path = `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`
  return (
    <g className={`concept-edge concept-edge-${data.kind}${data.count > 1 ? ' is-merged' : ''}`}>
      <path id={id} d={path} className="concept-edge-path" markerEnd={markerEnd} fill="none">
        {data.count > 1 && <title>{data.count} links</title>}
      </path>
    </g>
  )
}
