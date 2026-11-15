import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'

export type ConceptData = {
  label: string
  /** Drawn size in flow px (S(d), larger for a group). */
  size: number
  /** size / S0, for scaling text and padding. */
  scale: number
  /** Deeper part_of nodes are merged into this one at the current zoom. */
  isGroup: boolean
  isOrigin: boolean
  isCurrent: boolean
  /** The current node is merged into this one. */
  containsCurrent: boolean
  isFresh: boolean
  mini: boolean
}
export type ConceptFlowNode = Node<ConceptData, 'concept'>

export function ConceptNode({ data }: NodeProps<ConceptFlowNode>) {
  const cls = [
    'concept',
    data.mini && 'concept-mini',
    data.isOrigin && 'is-origin',
    (data.isCurrent || data.containsCurrent) && 'is-current',
    data.isFresh && 'is-fresh',
    data.isGroup && 'is-group',
  ]
    .filter(Boolean)
    .join(' ')
  const style = data.mini
    ? undefined
    : ({ '--node-size': `${data.size}px`, '--node-scale': data.scale } as CSSProperties)
  return (
    <div className={cls} style={style} title={data.label}>
      {/* Invisible centre handles; edges are drawn centre to border. */}
      <Handle type="target" position={Position.Top} className="concept-handle" isConnectable={false} />
      <Handle type="source" position={Position.Top} className="concept-handle" isConnectable={false} />
      {!data.mini && <span className="concept-label">{data.label}</span>}
    </div>
  )
}
