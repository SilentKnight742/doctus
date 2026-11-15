import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { useEffect, useMemo, useState } from 'react'
import { useSubject } from '../state/context'
import { ConceptNode, type ConceptFlowNode } from './ConceptNode'
import { FloatingEdge, type ConceptFlowEdge } from './FloatingEdge'
import { dMaxFor, group, minZoom, readSizeParams } from './zoom'

const nodeTypes = { concept: ConceptNode }
const edgeTypes = { concept: FloatingEdge }
const ALL_LEVELS = 64

interface Props {
  currentId: number | null
  onSelect?: (id: number) => void
  mini?: boolean
}

export function GraphCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ currentId, onSelect, mini = false }: Props) {
  const { graph, positions, freshIds } = useSubject()
  const params = useMemo(() => readSizeParams(), [])
  const lowest = minZoom(params)
  // Deepest part_of level drawn on its own; deeper nodes merge into groups.
  const [dMax, setDMax] = useState(ALL_LEVELS)
  const { fitView } = useReactFlow()

  const ids = useMemo(() => graph?.nodes.map((n) => n.id) ?? [], [graph])
  // The mini graph always shows every node, as dots.
  const view = useMemo(
    () =>
      group(
        ids,
        graph?.edges ?? [],
        mini ? ALL_LEVELS : dMax,
        params,
        graph?.subject.origin_node_id ?? null,
      ),
    [ids, graph, dMax, mini, params],
  )

  const nodes: ConceptFlowNode[] = useMemo(() => {
    if (!graph) return []
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const currentRep = currentId !== null ? view.rep.get(currentId) : undefined
    return view.nodes.map(({ id, rep, merged, size }) => {
      const hidden = rep !== id
      // A merged node sits at its group's position, so it slides in and out.
      const at = positions.get(hidden ? rep : id) ?? { x: 0, y: 0 }
      return {
        id: String(id),
        type: 'concept',
        position: at,
        origin: [0.5, 0.5] as [number, number],
        draggable: false,
        selectable: !hidden,
        className: hidden ? 'is-merged' : undefined,
        zIndex: hidden ? 0 : 1,
        data: {
          label: byId.get(id)?.name ?? '',
          size,
          scale: size / params.base,
          isGroup: merged > 0,
          isOrigin: id === graph.subject.origin_node_id,
          isCurrent: id === currentId,
          containsCurrent: currentRep === id && id !== currentId,
          isFresh:
            !hidden &&
            (freshIds.has(id) || [...freshIds].some((f) => view.rep.get(f) === id && f !== id)),
          mini,
        },
      }
    })
  }, [graph, view, positions, currentId, freshIds, mini, params])

  const edges: ConceptFlowEdge[] = useMemo(
    () =>
      view.edges.map((e) => ({
        id: e.key,
        source: String(e.source),
        target: String(e.target),
        type: 'concept',
        data: { kind: e.kind, count: e.count, mini },
        markerEnd:
          e.kind === 'related'
            ? undefined
            : {
                type: MarkerType.ArrowClosed,
                width: e.kind === 'part_of' ? 10 : 16,
                height: e.kind === 'part_of' ? 10 : 16,
                color:
                  e.kind === 'part_of'
                    ? 'var(--color-edge-part-of)'
                    : 'var(--color-edge-prerequisite)',
              },
      })),
    [view, mini],
  )

  // Keep the whole map in view in the mini graph as it grows.
  useEffect(() => {
    if (mini && nodes.length) {
      const t = setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 30)
      return () => clearTimeout(t)
    }
  }, [mini, nodes.length, fitView])

  return (
    <div className={`graph-canvas ${mini ? 'graph-mini' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2, minZoom: mini ? undefined : lowest }}
        minZoom={mini ? 0.02 : lowest}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={!mini}
        panOnDrag={!mini}
        zoomOnScroll={!mini}
        zoomOnPinch={!mini}
        zoomOnDoubleClick={!mini}
        preventScrolling={!mini}
        onInit={(rf) => {
          if (mini) return
          setDMax(dMaxFor(rf.getZoom(), params))
          // Dev aid for the screenshot script (scripts/screenshots.mjs).
          if (import.meta.env.DEV) (window as unknown as { __doctusFlow: unknown }).__doctusFlow = rf
        }}
        onMove={(_, vp) => !mini && setDMax((cur) => dMaxFor(vp.zoom, params, cur))}
        onNodeClick={(_, n) => {
          if (n.className !== 'is-merged') onSelect?.(Number(n.id))
        }}
      >
        {!mini && <Background variant={BackgroundVariant.Dots} gap={22} size={1} />}
        {!mini && <Controls showInteractive={false} />}
      </ReactFlow>
    </div>
  )
}
