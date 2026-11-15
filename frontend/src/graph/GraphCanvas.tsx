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
import { collapse, levelForZoom, type ZoomLevel } from './zoom'

const nodeTypes = { concept: ConceptNode }
const edgeTypes = { concept: FloatingEdge }

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
  const [level, setLevel] = useState<ZoomLevel>('detail')
  const { fitView } = useReactFlow()

  const ids = useMemo(() => graph?.nodes.map((n) => n.id) ?? [], [graph])
  // The mini graph always shows every node, as dots.
  const view = useMemo(
    () => collapse(ids, graph?.edges ?? [], mini ? 'detail' : level),
    [ids, graph, level, mini],
  )

  const nodes: ConceptFlowNode[] = useMemo(() => {
    if (!graph) return []
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const currentRep = currentId !== null ? view.rep.get(currentId) : undefined
    return view.nodes.map(({ id, hidden }) => ({
      id: String(id),
      type: 'concept',
      position: positions.get(id) ?? { x: 0, y: 0 },
      origin: [0.5, 0.5] as [number, number],
      draggable: false,
      data: {
        label: byId.get(id)?.name ?? '',
        hidden,
        isOrigin: id === graph.subject.origin_node_id,
        isCurrent: id === currentId,
        containsCurrent: currentRep === id && id !== currentId,
        isFresh:
          freshIds.has(id) || [...freshIds].some((f) => view.rep.get(f) === id && f !== id),
        mini,
      },
    }))
  }, [graph, view, positions, currentId, freshIds, mini])

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
    <div className={`graph-canvas ${mini ? 'graph-mini' : ''}`} data-level={mini ? 'mini' : level}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.15}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={!mini}
        panOnDrag={!mini}
        zoomOnScroll={!mini}
        zoomOnPinch={!mini}
        zoomOnDoubleClick={!mini}
        preventScrolling={!mini}
        onInit={(rf) => !mini && setLevel(levelForZoom(rf.getZoom()))}
        onMove={(_, vp) => !mini && setLevel((cur) => levelForZoom(vp.zoom, cur))}
        onNodeClick={(_, n) => onSelect?.(Number(n.id))}
      >
        {!mini && <Background variant={BackgroundVariant.Dots} gap={22} size={1} />}
        {!mini && <Controls showInteractive={false} />}
      </ReactFlow>
    </div>
  )
}
