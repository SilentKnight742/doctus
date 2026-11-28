import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api/client'
import type { ReasonDetail, Widget, WidgetRef, WidgetType } from '../api/types'
import type { FieldCtx } from '../widgets/fields'
import { WidgetEditor } from '../widgets/WidgetEditor'
import { WidgetBody, WidgetHeading } from '../widgets/WidgetView'

export type WidgetNodeData = {
  widget: Widget
  type: WidgetType
  ctx: FieldCtx
  reasons: ReasonDetail[]
  origin: WidgetRef | null
  isNew: boolean
  isFocus: boolean
}
export type WidgetFlowNode = Node<WidgetNodeData, 'widget'>

function Reasons({ widget, reasons, spaceId }: { widget: Widget; reasons: ReasonDetail[]; spaceId: number }) {
  const [open, setOpen] = useState(false)
  if (!reasons.length) return null
  return (
    <div className="reasons-badge nodrag">
      <button
        type="button"
        className="reasons-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Reasons linking this widget to others"
      >
        ⇄ {reasons.length}
      </button>
      {open && (
        <ul className="reasons-pop nowheel">
          {reasons.map((r) => {
            const other = r.a.id === widget.id ? r.b : r.a
            return (
              <li key={r.id}>
                <span className="reason-kind">{r.kind}</span>
                <span className="author" data-author={r.author}>
                  {r.author === 'ai' ? 'AI' : 'User'}
                </span>
                <p className="reasons-text">{r.text}</p>
                <Link className="widget-jump" to={`/s/${spaceId}/w/${other.world_id}?focus=${other.id}`}>
                  <span className="widget-jump-title">→ {other.title}</span>
                  <span className="widget-jump-world">{other.world_title}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** A widget on the world canvas: drag, resize, edit in place, see its reasons. */
export function WidgetNode({ data, selected }: NodeProps<WidgetFlowNode>) {
  const { widget, type, ctx, reasons, origin, isNew, isFocus } = data
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)

  return (
    <div
      className={`widget-card${selected ? ' is-selected' : ''}${isNew ? ' is-new' : ''}${isFocus ? ' is-focus' : ''}${editing ? ' is-editing' : ''}`}
      data-view={type.view}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button, input, textarea, select, label')) return
        setEditing(true)
      }}
    >
      <NodeResizer
        isVisible={selected && !editing}
        minWidth={200}
        minHeight={100}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, p) =>
          api.updateWidget(widget.id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })
        }
      />
      <header className="widget-head">
        <WidgetHeading widget={widget} type={type} />
        <span className="widget-tools nodrag">
          <Reasons widget={widget} reasons={reasons} spaceId={ctx.spaceId} />
          {!editing && (
            <>
              <button type="button" className="icon-button small" aria-label="Edit widget" onClick={() => setEditing(true)}>
                ✎
              </button>
              <button type="button" className="icon-button small" aria-label="Delete widget" onClick={() => setConfirm(true)}>
                ×
              </button>
            </>
          )}
        </span>
      </header>
      {confirm && (
        <div className="inline-confirm nodrag">
          <span className="small">
            Delete{reasons.length ? ` it and its ${reasons.length} reason${reasons.length === 1 ? '' : 's'}` : ''}?
          </span>
          <button type="button" className="link-button small danger" onClick={() => api.deleteWidget(widget.id)}>
            Delete
          </button>
          <button type="button" className="link-button small" onClick={() => setConfirm(false)}>
            Keep
          </button>
        </div>
      )}
      <div className="widget-scroll nowheel">
        {editing ? (
          <WidgetEditor
            widget={widget}
            type={type}
            ctx={ctx}
            onSave={async (d) => {
              await api.updateWidget(widget.id, { data: d })
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <WidgetBody widget={widget} type={type} ctx={ctx} onPatch={(d) => api.updateWidget(widget.id, { data: d })} />
        )}
      </div>
      <footer className="widget-foot small muted">
        <span>
          {type.label}
          {!type.builtin && ' · space type'}
        </span>
        {origin && (
          <Link className="nodrag" to={`/s/${ctx.spaceId}/w/${origin.world_id}?focus=${origin.id}`}>
            copied from {origin.world_title}
          </Link>
        )}
      </footer>
    </div>
  )
}
