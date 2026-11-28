import { useQuery } from '@tanstack/react-query'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, describeError } from '../api/client'
import type { Id, WidgetType } from '../api/types'
import { ChatPanel } from '../chat/ChatPanel'
import { widgetTitle } from '../schema/validate'
import { Crumbs, DemoBadge } from '../shell/AppShell'
import { FloatingWindow } from '../shell/FloatingWindow'
import type { FieldCtx } from '../widgets/fields'
import { starterData } from '../widgets/starter'
import { WidgetNode, type WidgetFlowNode } from './WidgetNode'

const nodeTypes: NodeTypes = { widget: WidgetNode }
const FRESH_MS = 4000
// Fit the canvas to the space right of the chat window (docked bottom-left).
const FIT = { maxZoom: 1, padding: { top: '56px', right: '56px', bottom: '56px', left: '420px' } } as const

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  if (!editing)
    return (
      <h1>
        <button type="button" className="title-button" onClick={() => (setText(value), setEditing(true))} title="Rename">
          {value}
        </button>
      </h1>
    )
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) onSave(text.trim())
        setEditing(false)
      }}
    >
      <input
        className="title-input"
        aria-label="Node title"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
      />
    </form>
  )
}

function AddWidgetMenu({ types, onPick }: { types: WidgetType[]; onPick: (t: WidgetType) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu-wrap">
      <button type="button" className="button small-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        + Widget
      </button>
      {open && (
        <div className="menu type-menu" role="menu">
          {types.map((t) => (
            <button
              key={t.name}
              type="button"
              role="menuitem"
              className="type-menu-item"
              onClick={() => {
                setOpen(false)
                onPick(t)
              }}
            >
              <span>
                {t.label}
                {!t.builtin && <span className="type-tag">space type</span>}
              </span>
              <span className="muted small">{t.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function WorldCanvas({ spaceId, worldId }: { spaceId: Id; worldId: Id }) {
  const navigate = useNavigate()
  const rf = useReactFlow()
  const [params] = useSearchParams()
  const focus = params.get('focus') ? Number(params.get('focus')) : null
  const view = useQuery({ queryKey: ['world', worldId], queryFn: () => api.getWorld(worldId) })
  const space = useQuery({ queryKey: ['space', spaceId], queryFn: () => api.getSpace(spaceId) })
  const [nodes, setNodes, onNodesChange] = useNodesState<WidgetFlowNode>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const count = useRef(0)
  const data = view.data

  const ctx: FieldCtx = useMemo(
    () => ({
      spaceId,
      worlds: space.data?.worlds ?? [],
      widgets: data?.widgets.map((w) => ({
        id: w.id,
        world_id: w.world_id,
        title: widgetTitle(
          data.widget_types.find((t) => t.name === w.type),
          w.data,
        ),
      })),
    }),
    [spaceId, space.data, data],
  )

  useEffect(() => {
    if (!data) return
    const now = Date.now()
    setNodes((prev) =>
      data.widgets.map((w) => {
        const p = prev.find((n) => n.id === String(w.id))
        const busy = p?.dragging || p?.resizing
        return {
          id: String(w.id),
          type: 'widget',
          position: busy ? p!.position : { x: w.x, y: w.y },
          width: busy ? p!.width : w.w,
          height: busy ? p!.height : w.h,
          selected: p?.selected,
          dragHandle: '.widget-head',
          data: {
            widget: w,
            type: data.widget_types.find((t) => t.name === w.type)!,
            ctx,
            reasons: data.reasons.filter((r) => r.widget_a === w.id || r.widget_b === w.id),
            origin: data.origins.find((o) => o.id === w.copied_from) ?? null,
            isNew: now - w.created_at < FRESH_MS && count.current > 0,
            isFocus: w.id === focus,
          },
        }
      }),
    )
    if (data.widgets.length > count.current && count.current > 0 && !focus)
      setTimeout(() => rf.fitView({ ...FIT, duration: 400 }), 60)
    count.current = data.widgets.length
  }, [data, ctx, focus, setNodes, rf])

  // Jump to a widget (from a reason elsewhere): centre it; the card flashes once.
  const hasFocus = focus != null && !!data?.widgets.some((x) => x.id === focus)
  useEffect(() => {
    if (!hasFocus) return
    const t = setTimeout(() => rf.fitView({ nodes: [{ id: String(focus) }], duration: 450, maxZoom: 1, padding: 0.6 }), 80)
    return () => clearTimeout(t)
  }, [hasFocus, focus, rf])

  if (view.error)
    return (
      <div className="page-pad stack">
        <p className="error-banner">{describeError(view.error)}</p>
        <Link to={`/s/${spaceId}`}>← Back to space</Link>
      </div>
    )
  if (!data) return <p className="page-pad muted">Loading…</p>

  const addWidget = async (t: WidgetType) => {
    const el = document.querySelector('.world-canvas')?.getBoundingClientRect()
    const p = rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 3 })
    await api.createWidget({
      world_id: worldId,
      type: t.name,
      data: starterData(t),
      x: Math.round(p.x - t.default_size.w / 2),
      y: Math.round(p.y),
    })
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <Crumbs space={data.space} />
        <span className="world-dot" data-colour={data.world.colour} aria-hidden />
        <div className="screen-title">
          <EditableTitle value={data.world.title} onSave={(title) => api.updateWorld(worldId, { title })} />
          <span className="muted small">{data.world.summary}</span>
        </div>
        <AddWidgetMenu types={data.widget_types} onPick={addWidget} />
        {confirmDelete ? (
          <span className="inline-confirm">
            <span className="small">Delete this node, its {data.widgets.length} widgets and their reasons?</span>
            <button
              type="button"
              className="link-button small danger"
              onClick={async () => {
                await api.deleteWorld(worldId)
                navigate(`/s/${spaceId}`)
              }}
            >
              Delete
            </button>
            <button type="button" className="link-button small" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="button ghost small-button" onClick={() => setConfirmDelete(true)}>
            Delete node
          </button>
        )}
        <DemoBadge />
      </header>
      <div className="screen-body">
        <div className="canvas-col">
          <div className="world-canvas canvas">
            <ReactFlow
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_, n) => api.updateWidget(Number(n.id), { x: Math.round(n.position.x), y: Math.round(n.position.y) })}
              fitView
              fitViewOptions={FIT}
              minZoom={0.2}
              maxZoom={1.5}
              nodesConnectable={false}
              deleteKeyCode={null}
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
            {data.widgets.length === 0 && (
              <div className="canvas-empty">
                <p>No widgets yet.</p>
                <p className="muted small">Add one with “+ Widget”, or ask the node agent.</p>
              </div>
            )}
          </div>
        </div>
      </div>
      <FloatingWindow
        storeKey="doctus.win.node-chat"
        title="Node chat"
        badge={<span className="demo-badge">Scripted</span>}
        left={16}
        width={380}
        height={540}
        className="chat-win"
      >
        <ChatPanel
          key={worldId}
          scope={{ kind: 'world', id: worldId }}
          intro="The node agent knows every widget in this node. It creates, edits and arranges them."
        />
      </FloatingWindow>
    </div>
  )
}

export function WorldScreen() {
  const { spaceId, worldId } = useParams()
  const s = Number(spaceId)
  const w = Number(worldId)
  if (!Number.isInteger(s) || !Number.isInteger(w)) return <p className="page-pad error-banner">No such node.</p>
  return (
    <ReactFlowProvider key={w}>
      <WorldCanvas spaceId={s} worldId={w} />
    </ReactFlowProvider>
  )
}
