import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useNavigate } from 'react-router'
import type { WidgetType, WorldSummary } from '../api/types'

export type WorldNodeData = {
  world: WorldSummary
  types: WidgetType[]
  isNew: boolean
}
export type WorldFlowNode = Node<WorldNodeData, 'world'>

/** A world on the space canvas: title, summary, widget count and a preview of its widget types. */
export function WorldNode({ data, selected }: NodeProps<WorldFlowNode>) {
  const navigate = useNavigate()
  const { world, types, isNew } = data
  const counts = new Map<string, number>()
  for (const t of world.widget_types) counts.set(t, (counts.get(t) ?? 0) + 1)
  const open = () => navigate(`/s/${world.space_id}/w/${world.id}`)
  return (
    <div
      className={`world-card${selected ? ' is-selected' : ''}${isNew ? ' is-new' : ''}`}
      data-colour={world.colour}
      onDoubleClick={open}
    >
      <Handle type="source" position={Position.Top} className="hidden-handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} className="hidden-handle" isConnectable={false} />
      <div className="world-card-head">
        <h3 className="world-card-title">{world.title}</h3>
        <button type="button" className="world-open nodrag" onClick={open} aria-label={`Open ${world.title}`}>
          Open
        </button>
      </div>
      {world.summary && <p className="world-card-summary">{world.summary}</p>}
      <div className="world-card-foot">
        <span className="small muted">
          {world.widget_count} widget{world.widget_count === 1 ? '' : 's'}
        </span>
        <span className="type-chips">
          {[...counts].map(([name, n]) => (
            <span key={name} className="type-chip" title={types.find((t) => t.name === name)?.label ?? name}>
              {types.find((t) => t.name === name)?.label ?? name}
              {n > 1 && <span className="type-chip-n">×{n}</span>}
            </span>
          ))}
        </span>
      </div>
    </div>
  )
}
