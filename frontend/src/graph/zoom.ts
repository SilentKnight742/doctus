/**
 * Semantic zoom, computed at render time from part_of edges.
 *
 * Levels: overview (part_of roots only), topics (depth <= 1), detail (all).
 * Each node is represented by its ancestor at the level's maximum depth;
 * edges are remapped to representatives, self-loops dropped and parallel
 * edges of the same kind merged with a count.
 */
import type { EdgeKind, GraphEdge } from '../api/types'
import { depths, partOfParents } from './model'

export type ZoomLevel = 'overview' | 'topics' | 'detail'

export const ZOOM_THRESHOLDS = { topics: 0.55, detail: 1.0 } as const
const HYSTERESIS = 0.05

const RANK: Record<ZoomLevel, number> = { overview: 0, topics: 1, detail: 2 }

const MAX_DEPTH: Record<ZoomLevel, number> = {
  overview: 0,
  topics: 1,
  detail: Number.POSITIVE_INFINITY,
}

/** Level for a React Flow zoom value; `current` adds hysteresis at the edges. */
export function levelForZoom(zoom: number, current?: ZoomLevel): ZoomLevel {
  const raw = (z: number): ZoomLevel =>
    z >= ZOOM_THRESHOLDS.detail ? 'detail' : z >= ZOOM_THRESHOLDS.topics ? 'topics' : 'overview'
  if (!current) return raw(zoom)
  const next = raw(zoom)
  if (next === current) return current
  // Only switch once the zoom is clearly past the boundary.
  const probe = RANK[next] > RANK[current] ? zoom - HYSTERESIS : zoom + HYSTERESIS
  return raw(probe)
}

export interface VisibleNode {
  id: number
  /** Descendants folded into this node at this level. */
  hidden: number
}

export interface MergedEdge {
  key: string
  source: number
  target: number
  kind: EdgeKind
  count: number
  edgeIds: number[]
}

export interface Collapsed {
  nodes: VisibleNode[]
  edges: MergedEdge[]
  /** node id -> the visible node that stands for it */
  rep: Map<number, number>
}

export function collapse(nodeIds: number[], edges: GraphEdge[], level: ZoomLevel): Collapsed {
  const maxDepth = MAX_DEPTH[level]
  const parent = partOfParents(edges)
  const depth = depths(parent, nodeIds)
  const known = new Set(nodeIds)

  const rep = new Map<number, number>()
  for (const id of nodeIds) {
    let cur = id
    while ((depth.get(cur) ?? 0) > maxDepth) {
      const p = parent.get(cur)
      if (p === undefined || !known.has(p)) break
      cur = p
    }
    rep.set(id, cur)
  }

  const hidden = new Map<number, number>()
  for (const [id, r] of rep) if (id !== r) hidden.set(r, (hidden.get(r) ?? 0) + 1)
  const nodes = [...new Set(rep.values())]
    .sort((a, b) => a - b)
    .map((id) => ({ id, hidden: hidden.get(id) ?? 0 }))

  const merged = new Map<string, MergedEdge>()
  for (const e of [...edges].sort((a, b) => a.id - b.id)) {
    if (!known.has(e.source) || !known.has(e.target)) continue
    let s = rep.get(e.source)!
    let t = rep.get(e.target)!
    if (s === t) continue
    if (e.kind === 'related' && s > t) [s, t] = [t, s] // undirected
    const key = `${e.kind}:${s}:${t}`
    const m = merged.get(key)
    if (m) {
      m.count++
      m.edgeIds.push(e.id)
    } else {
      merged.set(key, { key, source: s, target: t, kind: e.kind, count: 1, edgeIds: [e.id] })
    }
  }
  return { nodes, edges: [...merged.values()], rep }
}
