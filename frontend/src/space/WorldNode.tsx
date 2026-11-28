import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { WorldSummary } from '../api/types'

export type WorldNodeData = {
  world: WorldSummary
  isNew: boolean
}
export type WorldFlowNode = Node<WorldNodeData, 'world'>

/** A node on the space canvas: its colour and title; the summary shows on hover. Click opens it. */
export function WorldNode({ data }: NodeProps<WorldFlowNode>) {
  const { world, isNew } = data
  return (
    <div className={`node-card${isNew ? ' is-new' : ''}`} data-colour={world.colour}>
      <Handle type="source" position={Position.Top} className="hidden-handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} className="hidden-handle" isConnectable={false} />
      <span className="world-dot" aria-hidden />
      <h3 className="node-card-title">{world.title}</h3>
      {world.summary && (
        <p className="node-card-summary" role="tooltip">
          {world.summary}
        </p>
      )}
    </div>
  )
}
