/**
 * Semantic zoom by on-screen size, computed at render time from part_of edges.
 *
 * A node at part_of depth d has base size S(d) = S0 * r^d. Its on-screen
 * size is S(d) * zoom. When that falls below MIN the node merges into its
 * nearest visible part_of ancestor (the group, shown with the ancestor's own
 * name, larger by sqrt of what it holds). It splits out again only above
 * MIN * split (hysteresis). Nodes with no part_of parent (depth 0) never
 * merge. The origin is the subject itself, so its direct part_of children
 * count as depth 0 as well: zoomed all the way out you see the origin, its
 * direct parts and any other part_of roots. All constants come from
 * theme.css.
 */
import type { EdgeKind, GraphEdge } from '../api/types'
import { depths, partOfParents } from './model'

export interface SizeParams {
  /** S0: base size of a depth-0 node, px */
  base: number
  /** r: size ratio per part_of level */
  ratio: number
  /** MIN: smallest on-screen size before merging, px */
  minScreen: number
  /** split only above MIN * split */
  split: number
  /** group size = S(d) * min(1 + growth * sqrt(n), cap) */
  groupGrowth: number
  groupCap: number
}

export const DEFAULT_SIZE: SizeParams = {
  base: 160,
  ratio: 0.75,
  minScreen: 48,
  split: 1.15,
  groupGrowth: 0.2,
  groupCap: 1.5,
}

const VARS: Record<keyof SizeParams, string> = {
  base: '--zoom-node-base',
  ratio: '--zoom-node-ratio',
  minScreen: '--zoom-min-screen',
  split: '--zoom-split-factor',
  groupGrowth: '--zoom-group-growth',
  groupCap: '--zoom-group-cap',
}

/** Read the constants from theme.css (unitless numbers), with defaults. */
export function readSizeParams(el?: Element): SizeParams {
  const out = { ...DEFAULT_SIZE }
  if (typeof window === 'undefined') return out
  const style = getComputedStyle(el ?? document.documentElement)
  for (const key of Object.keys(VARS) as (keyof SizeParams)[]) {
    const v = parseFloat(style.getPropertyValue(VARS[key]))
    if (Number.isFinite(v) && v > 0) out[key] = v
  }
  return out
}

const MAX_DEPTH = 64

export function nodeSize(depth: number, p: SizeParams): number {
  return p.base * Math.pow(p.ratio, depth)
}

/** Furthest zoom-out: only depth 0 is still readable (MIN / S0). */
export function minZoom(p: SizeParams): number {
  return p.minScreen / p.base
}

/**
 * Deepest part_of level shown at `zoom`. Without `current` it is the plain
 * rule (S(d) * zoom >= MIN). With `current` (the level shown now) levels
 * merge below MIN but only split above MIN * split.
 */
export function dMaxFor(zoom: number, p: SizeParams, current?: number): number {
  const screen = (d: number) => nodeSize(d, p) * zoom
  if (current === undefined) {
    let d = 0
    while (d < MAX_DEPTH && screen(d + 1) >= p.minScreen) d++
    return d
  }
  let d = Math.max(0, Math.min(current, MAX_DEPTH))
  while (d > 0 && screen(d) < p.minScreen) d--
  while (d < MAX_DEPTH && screen(d + 1) > p.minScreen * p.split) d++
  return d
}

export function groupSize(depth: number, merged: number, p: SizeParams): number {
  const s = nodeSize(depth, p)
  if (merged <= 0) return s
  return s * Math.min(1 + p.groupGrowth * Math.sqrt(merged), p.groupCap)
}

/**
 * part_of parent map for zooming: like the stored one, except the origin is
 * never a parent (its direct parts are top level).
 */
export function zoomParents(edges: GraphEdge[], originId: number | null): Map<number, number> {
  const parent = partOfParents(edges)
  if (originId !== null) {
    for (const [child, up] of [...parent]) if (up === originId) parent.delete(child)
  }
  return parent
}

/** Zoom depth of every node (see zoomParents). */
export function zoomDepths(nodeIds: number[], edges: GraphEdge[], originId: number | null) {
  return depths(zoomParents(edges, originId), nodeIds)
}

export interface ShownNode {
  id: number
  depth: number
  /** The visible node this one is drawn as (itself when visible). */
  rep: number
  /** Number of descendants merged into this node (0 for a plain node). */
  merged: number
  /** Drawn size in flow px (before zoom). */
  size: number
}

export interface MergedEdge {
  key: string
  source: number
  target: number
  kind: EdgeKind
  count: number
  edgeIds: number[]
}

export interface Grouped {
  /** Every node, visible or merged, so merged ones can animate into place. */
  nodes: ShownNode[]
  /** Edges between visible nodes, merged. */
  edges: MergedEdge[]
  rep: Map<number, number>
}

export function group(
  nodeIds: number[],
  edges: GraphEdge[],
  dMax: number,
  p: SizeParams,
  originId: number | null = null,
): Grouped {
  const parent = zoomParents(edges, originId)
  const depth = depths(parent, nodeIds)
  const known = new Set(nodeIds)

  // Nearest visible ancestor: walk up while deeper than dMax.
  const rep = new Map<number, number>()
  for (const id of nodeIds) {
    let cur = id
    while ((depth.get(cur) ?? 0) > dMax) {
      const up = parent.get(cur)
      if (up === undefined || !known.has(up)) break
      cur = up
    }
    rep.set(id, cur)
  }

  const merged = new Map<number, number>()
  for (const [id, r] of rep) if (id !== r) merged.set(r, (merged.get(r) ?? 0) + 1)

  const nodes = [...nodeIds]
    .sort((a, b) => a - b)
    .map((id) => {
      const d = depth.get(id) ?? 0
      const m = merged.get(id) ?? 0
      return { id, depth: d, rep: rep.get(id)!, merged: m, size: groupSize(d, m, p) }
    })

  return { nodes, edges: mergeEdges(edges, rep), rep }
}

/** Remap edges to representatives, drop internal ones, merge parallels. */
export function mergeEdges(edges: GraphEdge[], rep: Map<number, number>): MergedEdge[] {
  const out = new Map<string, MergedEdge>()
  for (const e of [...edges].sort((a, b) => a.id - b.id)) {
    let s = rep.get(e.source)
    let t = rep.get(e.target)
    if (s === undefined || t === undefined || s === t) continue
    if (e.kind === 'related' && s > t) [s, t] = [t, s] // undirected
    const key = `${e.kind}:${s}:${t}`
    const m = out.get(key)
    if (m) {
      m.count++
      m.edgeIds.push(e.id)
    } else {
      out.set(key, { key, source: s, target: t, kind: e.kind, count: 1, edgeIds: [e.id] })
    }
  }
  return [...out.values()]
}
