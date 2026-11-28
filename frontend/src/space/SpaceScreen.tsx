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
import { Crumbs, DemoBadge } from '../shell/AppShell'
import { FloatingWindow } from '../shell/FloatingWindow'
import { arrange } from './arrange'
import { ConnectionEdge, type ConnectionFlowEdge } from './ConnectionEdge'
import { ConnectionSheet } from './ConnectionSheet'
import { NewWorldDialog } from './NewWorldDialog'
import { SpaceWidgets } from './SpaceWidgets'
import { WorldNode, type WorldFlowNode } from './WorldNode'

/** The nearest place to `p` (searching outward) where a new node does not overlap one. */
function freeSpot(p: { x: number; y: number }, worlds: World[]) {
  const pad = 24
  const clear = (x: number, y: number) =>
    worlds.every((w) => x + w.w + pad <= w.x || w.x + w.w + pad <= x || y + w.h + pad <= w.y || w.y + w.h + pad <= y)
  for (let r = 0; r <= 12; r++)
    for (let i = 0; i < Math.max(1, r * 8); i++) {
      const a = (i / Math.max(1, r * 8)) * 2 * Math.PI
      const x = Math.round(p.x + Math.cos(a) * r * 60)
      const y = Math.round(p.y + Math.sin(a) * r * 40)
      if (clear(x, y)) return { x, y }
    }
  return p
}

const nodeTypes: NodeTypes = { world: WorldNode }
const edgeTypes: EdgeTypes = { connection: ConnectionEdge }
const FRESH_MS = 4000
// Fit the canvas to the space right of the chat window (docked bottom-left).
const FIT = { maxZoom: 1, padding: { top: '56px', right: '56px', bottom: '56px', left: '420px' } } as const

function SpaceCanvas({ spaceId }: { spaceId: Id }) {
  const navigate = useNavigate()
  const rf = useReactFlow()
  const view = useQuery({ queryKey: ['space', spaceId], queryFn: () => api.getSpace(spaceId) })
  const [nodes, setNodes, onNodesChange] = useNodesState<WorldFlowNode>([])
  const [open, setOpen] = useState<{ a: Id; b: Id } | null>(null)
  const [picked, setSelected] = useState<Map<Id, ReasonDetail>>(new Map())
  const [dialog, setDialog] = useState(false)
  const [made, setMade] = useState<World | null>(null)
  const [arranging, setArranging] = useState(false)
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
          data: { world: w, isNew: now - w.created_at < FRESH_MS },
        }
      }),
    )
    // Keep new worlds in view while an agent builds the space.
    if (data.worlds.length > worldCount.current && worldCount.current > 0)
      setTimeout(() => rf.fitView({ ...FIT, duration: 400 }), 60)
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
    return freeSpot({ x: Math.round(p.x - 100), y: Math.round(p.y - 22) }, data?.worlds ?? [])
  }

  // Tidy node positions so fewer connection lines cross; the move animates.
  const tidy = async () => {
    if (!data) return
    const next = arrange(
      data.worlds.map((w) => ({ id: w.id, x: w.x, y: w.y })),
      data.connections.map((c) => ({ a: c.world_a, b: c.world_b, weight: c.reason_count })),
    )
    setArranging(true)
    await Promise.all([...next].map(([id, p]) => api.updateWorld(id, { x: Math.round(p.x), y: Math.round(p.y) })))
    setTimeout(() => rf.fitView({ ...FIT, duration: 400 }), 80)
    setTimeout(() => setArranging(false), 600)
  }

  if (view.error) return <p className="page-pad error-banner">{describeError(view.error)}</p>
  if (!data) return <p className="page-pad muted">Loading…</p>

  const pairs = new Set([...selected.values()].map((r) => pairKey(r.a.world_id!, r.b.world_id!)))

  return (
    <div className="screen">
      <header className="screen-head">
        <Crumbs />
        <div className="screen-title">
          <h1>{data.space.title}</h1>
          <span className="muted small">
            {data.worlds.length} nodes · {data.connections.length} connections. Click a node to open it, a line to see
            why two nodes connect.
          </span>
        </div>
        <button
          type="button"
          className="button ghost small-button"
          disabled={data.worlds.length < 2 || arranging}
          onClick={tidy}
          title="Tidy node positions so fewer lines cross"
        >
          Arrange
        </button>
        <button
          type="button"
          className="button small-button"
          onClick={async () => {
            const w = await api.createWorld(spaceId, { title: 'Untitled node', ...center() })
            navigate(`/s/${spaceId}/w/${w.id}`)
          }}
        >
          + Node
        </button>
        <DemoBadge />
      </header>
      <div className="screen-body">
        <div className="canvas-col">
          <div className={`space-canvas canvas${arranging ? ' is-arranging' : ''}`}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_, n) => api.updateWorld(Number(n.id), { x: Math.round(n.position.x), y: Math.round(n.position.y) })}
              onNodeClick={(_, n) => navigate(`/s/${spaceId}/w/${n.id}`)}
              onEdgeClick={(_, e) => setOpen({ a: Number(e.source), b: Number(e.target) })}
              onPaneClick={() => setMade(null)}
              fitView
              fitViewOptions={FIT}
              minZoom={0.2}
              maxZoom={1.6}
              nodesConnectable={false}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
            {data.worlds.length === 0 && (
              <div className="canvas-empty">
                <p>This space is empty.</p>
                <p className="muted small">Ask the space agent (bottom left) to set it up, or add a node.</p>
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
                  New node from selection…
                </button>
              </div>
            )}
            {made && (
              <div className="toast" role="status">
                Created node “{made.title}”.{' '}
                <Link to={`/s/${spaceId}/w/${made.id}`} className="link-button">
                  Open it
                </Link>
                <button type="button" className="icon-button small" aria-label="Dismiss" onClick={() => setMade(null)}>
                  ×
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {open && (
        <FloatingWindow
          storeKey="doctus.win.connection"
          title="Connection"
          left={412}
          width={Math.max(480, Math.min(900, window.innerWidth - 428))}
          height={380}
          className="connection-win"
        >
          <ConnectionSheet
            key={pairKey(open.a, open.b)}
            spaceId={spaceId}
            worldA={open.a}
            worldB={open.b}
            selected={selected}
            onToggle={toggle}
            onClose={() => setOpen(null)}
          />
        </FloatingWindow>
      )}
      <FloatingWindow
        storeKey="doctus.win.space-chat"
        title="Space chat"
        badge={<span className="demo-badge">Scripted</span>}
        left={16}
        width={380}
        height={540}
        className="chat-win"
      >
        <ChatPanel
          scope={{ kind: 'space', id: spaceId }}
          intro="The space agent creates nodes, adds reasons between them and instructs node agents."
        />
      </FloatingWindow>
      <FloatingWindow
        storeKey="doctus.win.space-widgets"
        title={`Space widgets (${data.space_widgets.length})`}
        dock="top"
        right={16}
        offset={12}
        width={600}
        height={540}
        minimised
        className="widgets-win"
      >
        <SpaceWidgets view={data} />
      </FloatingWindow>
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
