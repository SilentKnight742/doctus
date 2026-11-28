import {
  Controls,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Edge,
  type NodeChange,
  type Viewport,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Canvas } from '../api/types'
import { isTextField } from '../lib/keys'
import { useStreams } from '../state/streams-context'
import { ChatCard, NoteCard, type CardNode } from './cards'
import { layoutCanvas, type Placed, type Size } from './layout'

const nodeTypes = { chat: ChatCard, note: NoteCard }

/** A theme value in ms (e.g. "320ms") or px, read once from theme.css. */
function cssNumber(name: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(v) ? v : fallback
}

interface Props {
  canvas: Canvas
  selectedId: number | null
  onSelect: (id: number | null) => void
  /** Move the canvas to this node (e.g. a concept's home). A new object each request. */
  focus: { id: number } | null
  /** Bring this node into view once it is on the canvas, if it is off screen. */
  reveal: { id: number } | null
}

export function CanvasView({ canvas, selectedId, onSelect, focus, reveal }: Props) {
  const rf = useReactFlow<CardNode>()
  const streams = useStreams()
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CardNode>([])
  const [sizes, setSizes] = useState<Map<number, Size>>(() => new Map())
  const [ready, setReady] = useState(false)
  const known = useRef<Set<number> | null>(null)
  const fresh = useRef(new Set<number>())
  const prevPlaced = useRef<Map<number, Placed>>(new Map())
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId

  const moveMs = useMemo(() => cssNumber('--duration-layout', 320), [])

  // Animated pans, tracking where the viewport is heading so pans started on
  // the same layout change (keep-in-place, then reveal) add up.
  const target = useRef<{ vp: Viewport; until: number } | null>(null)
  const currentViewport = useCallback(
    () => (target.current && target.current.until > Date.now() ? target.current.vp : rf.getViewport()),
    [rf],
  )
  const panTo = useCallback(
    (vp: Viewport) => {
      target.current = { vp, until: Date.now() + moveMs }
      void rf.setViewport(vp, { duration: moveMs })
    },
    [rf, moveMs],
  )
  const estimate = useMemo(
    () => ({
      chat: { width: cssNumber('--card-width', 380), height: 220 },
      note: { width: cssNumber('--note-width', 300), height: 120 },
    }),
    [],
  )

  // New nodes (after the first load) get a brief highlight.
  const ids = canvas.nodes.map((n) => n.id)
  if (known.current === null) known.current = new Set(ids)
  else
    for (const id of ids)
      if (!known.current.has(id)) {
        known.current.add(id)
        fresh.current.add(id)
      }

  const placed = useMemo(() => {
    const kind = new Map(canvas.nodes.map((n) => [n.id, n.kind]))
    return layoutCanvas(canvas.nodes, canvas.root_id, (id) => sizes.get(id) ?? estimate[kind.get(id) ?? 'chat'])
  }, [canvas.nodes, canvas.root_id, sizes, estimate])

  const suggestionsBy = useMemo(() => {
    const m = new Map<number, Canvas['suggestions']>()
    for (const s of canvas.suggestions) m.set(s.canvas_node_id, [...(m.get(s.canvas_node_id) ?? []), s])
    return m
  }, [canvas.suggestions])

  // Build the flow nodes from the canvas, keeping React Flow's measurements.
  useEffect(() => {
    setNodes((prev) => {
      const before = new Map(prev.map((n) => [n.id, n]))
      return canvas.nodes
        .filter((n) => placed.has(n.id))
        .map((n) => {
          const p = placed.get(n.id)!
          const id = String(n.id)
          const old = before.get(id)
          return {
            ...(old ?? {}),
            id,
            type: n.kind,
            position: { x: p.x, y: p.y },
            selected: n.id === selectedId,
            draggable: false,
            connectable: false,
            data: {
              node: n,
              side: p.side,
              fresh: fresh.current.has(n.id),
              suggestions: suggestionsBy.get(n.id) ?? [],
            },
          }
        })
    })
  }, [canvas.nodes, placed, selectedId, suggestionsBy, setNodes])

  // Keep the selected node where it is on screen while the tree moves around it.
  useEffect(() => {
    const sel = selectedRef.current
    const before = sel !== null ? prevPlaced.current.get(sel) : undefined
    const after = sel !== null ? placed.get(sel) : undefined
    prevPlaced.current = placed
    if (!ready || !before || !after) return
    const dx = after.x - before.x
    const dy = after.y - before.y
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    const vp = currentViewport()
    panTo({ x: vp.x - dx * vp.zoom, y: vp.y - dy * vp.zoom, zoom: vp.zoom })
  }, [placed, ready, currentViewport, panTo])

  // Once every card has been measured, fit the map and turn on move animations.
  useEffect(() => {
    if (ready || !canvas.nodes.length) return
    if (canvas.nodes.every((n) => sizes.has(n.id))) {
      const t = window.setTimeout(() => {
        void rf.fitView({ padding: 0.15, maxZoom: 1 })
        setReady(true)
      }, 30)
      return () => window.clearTimeout(t)
    }
  }, [ready, canvas.nodes, sizes, rf])

  // Move to a node asked for by the parent (a concept chip's home node).
  useEffect(() => {
    if (!focus) return
    const p = placed.get(focus.id)
    if (!p) return
    const s = sizes.get(focus.id) ?? estimate.chat
    void rf.setCenter(p.x + s.width / 2, p.y + Math.min(s.height, 300) / 2, {
      zoom: Math.max(rf.getZoom(), 0.6),
      duration: moveMs,
    })
    // Only when a new focus request arrives, not when the layout moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // A new branch: once it is placed and measured, pan just enough to show it.
  const revealed = useRef<{ id: number } | null>(null)
  useEffect(() => {
    if (!reveal || revealed.current === reveal) return
    const p = placed.get(reveal.id)
    const s = sizes.get(reveal.id)
    const box = document.querySelector('.canvas')?.getBoundingClientRect()
    if (!p || !s || !box) return
    revealed.current = reveal
    const vp = currentViewport()
    const margin = 32
    const left = p.x * vp.zoom + vp.x
    const top = p.y * vp.zoom + vp.y
    const right = left + s.width * vp.zoom
    const bottom = top + Math.min(s.height, box.height / 2) * vp.zoom
    const dx = left < margin ? margin - left : right > box.width - margin ? box.width - margin - right : 0
    const dy = top < margin ? margin - top : bottom > box.height - margin ? box.height - margin - bottom : 0
    if (dx || dy) panTo({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom })
  }, [reveal, placed, sizes, currentViewport, panTo])

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      onNodesChangeBase(changes)
      const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions)
      if (!dims.length) return
      setSizes((prev) => {
        let next: Map<number, Size> | null = null
        for (const c of dims) {
          if (c.type !== 'dimensions' || !c.dimensions) continue
          const id = Number(c.id)
          const old = prev.get(id)
          const { width, height } = c.dimensions
          if (old && Math.abs(old.width - width) < 1 && Math.abs(old.height - height) < 1) continue
          next ??= new Map(prev)
          next.set(id, { width, height })
        }
        return next ?? prev
      })
    },
    [onNodesChangeBase],
  )

  const edges: Edge[] = useMemo(
    () =>
      canvas.nodes
        .filter((n) => n.parent_id !== null && placed.has(n.id) && placed.has(n.parent_id))
        .map((n) => {
          const left = placed.get(n.id)!.side === 'left'
          return {
            id: `t${n.id}`,
            source: String(n.parent_id),
            target: String(n.id),
            sourceHandle: left ? 'l-out' : 'r-out',
            targetHandle: left ? 'r-in' : 'l-in',
            type: 'default',
            className: 'tree-edge',
            selectable: false,
            focusable: false,
          }
        }),
    [canvas.nodes, placed],
  )

  // Canvas shortcuts (never while typing in a text field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target)) return
      if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault()
        void rf.fitView({ padding: 0.15, duration: moveMs })
      } else if (e.key === 'Escape' && (e.ctrlKey || e.metaKey)) {
        const running = [...streams.live.values()].filter((l) => l.running)
        const target = running.find((l) => l.nodeId === selectedRef.current) ?? running[0]
        if (target) {
          e.preventDefault()
          void streams.stop(target.nodeId)
        }
      } else if (e.key === 'Escape') {
        onSelect(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf, moveMs, streams, onSelect])

  return (
    <div className={`canvas${ready ? ' is-ready' : ''}`}>
      <ReactFlow<CardNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect(Number(n.id))}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        minZoom={0.15}
        maxZoom={1.5}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  )
}
