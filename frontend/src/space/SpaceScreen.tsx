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
  type EdgeTypes,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, describeError } from '../api/client'
import type { Id, ReasonDetail, World } from '../api/types'
import { pairKey } from '../mock/db'
import { ChatPanel } from '../chat/ChatPanel'
import { SidePanel } from '../shell/SidePanel'
import { ConnectionEdge, type ConnectionFlowEdge } from './ConnectionEdge'
import { ConnectionSheet } from './ConnectionSheet'
import { NewWorldDialog } from './NewWorldDialog'
import { SpaceWidgets } from './SpaceWidgets'
import { WorldNode, type WorldFlowNode } from './WorldNode'

const nodeTypes: NodeTypes = { world: WorldNode }
const edgeTypes: EdgeTypes = { connection: ConnectionEdge }
const FRESH_MS = 4000

function SpaceCanvas({ spaceId }: { spaceId: Id }) {
  const navigate = useNavigate()
  const rf = useReactFlow()
  const view = useQuery({ queryKey: ['space', spaceId], queryFn: () => api.getSpace(spaceId) })
  const [nodes, setNodes, onNodesChange] = useNodesState<WorldFlowNode>([])
  const [open, setOpen] = useState<{ a: Id; b: Id } | null>(null)
  const [picked, setSelected] = useState<Map<Id, ReasonDetail>>(new Map())
  const [dialog, setDialog] = useState(false)
  const [made, setMade] = useState<World | null>(null)
  const worldCount = useRef(0)

  const data = view.data
  useEffect(() => {
    if (!data) return
    const now = Date.now()
    setNodes((prev) =>
      data.worlds.map((w) => {
        const p = prev.find((n) => n.id === String(w.id))
        return {
          id: String(w.id),
          type: 'world',
          position: p?.dragging ? p.position : { x: w.x, y: w.y },
          selected: p?.selected,
          data: { world: w, types: data.widget_types, isNew: now - w.created_at < FRESH_MS },
        }
      }),
    )
    // Keep new worlds in view while an agent builds the space.
    if (data.worlds.length > worldCount.current && worldCount.current > 0)
      setTimeout(() => rf.fitView({ duration: 400, maxZoom: 1, padding: 0.15 }), 60)
    worldCount.current = data.worlds.length
  }, [data, setNodes, rf])

  // Selected reasons, minus any whose connection is gone.
  const selected = useMemo(() => {
    const live = new Set((data?.connections ?? []).map((c) => c.key))
    return new Map([...picked].filter(([, r]) => live.has(pairKey(r.a.world_id!, r.b.world_id!))))
  }, [picked, data])

  const edges: ConnectionFlowEdge[] = useMemo(() => {
    const perPair = new Map<string, number>()
    for (const r of selected.values()) {
      const k = pairKey(r.a.world_id!, r.b.world_id!)
      perPair.set(k, (perPair.get(k) ?? 0) + 1)
    }
    return (data?.connections ?? []).map((c) => ({
      id: c.key,
      source: String(c.world_a),
      target: String(c.world_b),
      type: 'connection',
      data: {
        count: c.reason_count,
        selectedCount: perPair.get(c.key) ?? 0,
        isOpen: !!open && pairKey(open.a, open.b) === c.key,
      },
    }))
  }, [data, selected, open])

  const toggle = (r: ReasonDetail) =>
    setSelected((s) => {
      const next = new Map(s)
      if (next.has(r.id)) next.delete(r.id)
      else next.set(r.id, r)
      return next
    })

  const center = () => {
    const el = document.querySelector('.space-canvas')?.getBoundingClientRect()
    const p = rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 })
    return { x: Math.round(p.x - 130), y: Math.round(p.y - 75) }
  }

  if (view.error) return <p className="page-pad error-banner">{describeError(view.error)}</p>
  if (!data) return <p className="page-pad muted">Loading…</p>

  const pairs = new Set([...selected.values()].map((r) => pairKey(r.a.world_id!, r.b.world_id!)))

  return (
    <div className="screen">
      <header className="screen-head">
        <div className="screen-title">
          <h1>{data.space.title}</h1>
          <span className="muted small">
            {data.worlds.length} worlds · {data.connections.length} connections. Click a line to see why two worlds
            connect.
          </span>
        </div>
        <button
          type="button"
          className="button small-button"
          onClick={async () => {
            const w = await api.createWorld(spaceId, { title: 'Untitled world', ...center() })
            navigate(`/s/${spaceId}/w/${w.id}`)
          }}
        >
          + World
        </button>
      </header>
      <div className="screen-body">
        <div className="canvas-col">
          <div className="space-canvas canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_, n) => api.updateWorld(Number(n.id), { x: Math.round(n.position.x), y: Math.round(n.position.y) })}
              onEdgeClick={(_, e) => setOpen({ a: Number(e.source), b: Number(e.target) })}
              onPaneClick={() => setMade(null)}
              fitView
              fitViewOptions={{ maxZoom: 1, padding: 0.15 }}
              minZoom={0.2}
              maxZoom={1.6}
              nodesConnectable={false}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
            {data.worlds.length === 0 && (
              <div className="canvas-empty">
                <p>This space is empty.</p>
                <p className="muted small">Ask the space agent (on the right) to set it up, or add a world.</p>
              </div>
            )}
            {selected.size > 0 && (
              <div className="selection-tray" role="status">
                <span>
                  <strong>{selected.size}</strong> reason{selected.size === 1 ? '' : 's'} selected across {pairs.size}{' '}
                  connection{pairs.size === 1 ? '' : 's'}
                </span>
                <button type="button" className="link-button small" onClick={() => setSelected(new Map())}>
                  Clear
                </button>
                <button type="button" className="button primary small-button" onClick={() => setDialog(true)}>
                  New world from selection…
                </button>
              </div>
            )}
            {made && (
              <div className="toast" role="status">
                Created world “{made.title}”.{' '}
                <Link to={`/s/${spaceId}/w/${made.id}`} className="link-button">
                  Open it
                </Link>
                <button type="button" className="icon-button small" aria-label="Dismiss" onClick={() => setMade(null)}>
                  ×
                </button>
              </div>
            )}
          </div>
          {open && (
            <ConnectionSheet
              key={pairKey(open.a, open.b)}
              spaceId={spaceId}
              worldA={open.a}
              worldB={open.b}
              selected={selected}
              onToggle={toggle}
              onClose={() => setOpen(null)}
            />
          )}
        </div>
        <SidePanel
          tabs={[
            {
              id: 'chat',
              label: 'Space chat',
              body: (
                <ChatPanel
                  scope={{ kind: 'space', id: spaceId }}
                  intro="The space agent creates worlds, adds reasons between them and instructs world agents."
                />
              ),
            },
            {
              id: 'widgets',
              label: `Space widgets (${data.space_widgets.length})`,
              body: <SpaceWidgets view={data} />,
              width: 'var(--panel-width-wide)',
            },
          ]}
        />
      </div>
      {dialog && (
        <NewWorldDialog
          spaceId={spaceId}
          reasons={[...selected.values()]}
          position={center()}
          onCancel={() => setDialog(false)}
          onDone={(w) => {
            setDialog(false)
            setSelected(new Map())
            setOpen(null)
            setMade(w)
          }}
        />
      )}
    </div>
  )
}

export function SpaceScreen() {
  const { spaceId } = useParams()
  const id = Number(spaceId)
  if (!Number.isInteger(id)) return <p className="page-pad error-banner">No such space.</p>
  return (
    <ReactFlowProvider key={id}>
      <SpaceCanvas spaceId={id} />
    </ReactFlowProvider>
  )
}
