import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

export type ConceptData = {
  label: string
  hidden: number
  isOrigin: boolean
  isCurrent: boolean
  /** The current node is folded inside this one. */
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
    data.hidden > 0 && 'is-collapsed',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} title={data.label}>
      {/* Invisible centre handles; edges are drawn centre to border. */}
      <Handle type="target" position={Position.Top} className="concept-handle" isConnectable={false} />
      <Handle type="source" position={Position.Top} className="concept-handle" isConnectable={false} />
      {!data.mini && <span className="concept-label">{data.label}</span>}
      {!data.mini && data.hidden > 0 && <span className="concept-count">+{data.hidden}</span>}
    </div>
  )
}
