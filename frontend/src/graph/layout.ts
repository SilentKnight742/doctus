/**
 * Deterministic radial layout.
 *
 * 1. The origin's part_of root sits at (0, 0).
 * 2. Other part_of roots sit on rings by their distance from the origin
 *    (over all edges, ignoring direction). Within a ring they are ordered by
 *    the mean angle of their neighbours further in, to cut crossings.
 * 3. Each root's part_of subtree is a compact "bubble": children on a small
 *    circle around their parent, recursively, sized by subtree.
 * 4. Stability: positions from a previous layout are kept; new nodes are
 *    placed relative to an already placed anchor and nudged off overlaps.
 */
import type { GraphEdge } from '../api/types'
import { childrenOf, partOfParents, rootOf } from './model'

export interface Point {
  x: number
  y: number
}

/** Half the space a single node needs (nodes are about 170x44 px). */
export const NODE_RADIUS = 95
const GAP = 30
const TAU = Math.PI * 2

export function layout(
  nodeIds: number[],
  edges: GraphEdge[],
  originId: number | null,
  previous?: Map<number, Point>,
  /** Half the space each node needs (defaults to NODE_RADIUS). */
  radiusOf: (id: number) => number = () => NODE_RADIUS,
): Map<number, Point> {
  const fresh = relax(freshLayout(nodeIds, edges, originId), edges, originId, radiusOf)
  if (!previous || previous.size === 0) return fresh
  return stabilise(nodeIds, edges, fresh, previous)
}

function freshLayout(nodeIds: number[], edges: GraphEdge[], originId: number | null) {
  const ids = [...nodeIds].sort((a, b) => a - b)
  const known = new Set(ids)
  const parent = partOfParents(edges)
  const children = childrenOf(parent, ids)
  const out = new Map<number, Point>()
  if (ids.length === 0) return out

  // ---- bubble radius per subtree ----
  const bubble = new Map<number, number>()
  const childRing = new Map<number, number>()
  const measure = (id: number): number => {
    const kids = children.get(id) ?? []
    if (kids.length === 0) {
      bubble.set(id, NODE_RADIUS)
      return NODE_RADIUS
    }
    const radii = kids.map(measure)
    const maxChild = Math.max(...radii)
    const around = radii.reduce((s, r) => s + 2 * r + GAP, 0) / TAU
    const ring = Math.max(NODE_RADIUS + maxChild + GAP, around)
    childRing.set(id, ring)
    const b = ring + maxChild
    bubble.set(id, b)
    return b
  }

  const placeSubtree = (id: number, at: Point, awayAngle: number | null) => {
    out.set(id, at)
    const kids = children.get(id) ?? []
    if (kids.length === 0) return
    const ring = childRing.get(id)!
    // Children of a nested node fan out away from its own parent; the
    // root's children use the full circle.
    const span = awayAngle === null ? TAU : Math.min(TAU, Math.PI * 1.5)
    const weights = kids.map((k) => 2 * bubble.get(k)! + GAP)
    const total = weights.reduce((a, b) => a + b, 0)
    const start = awayAngle === null ? -Math.PI / 2 : awayAngle - span / 2
    let acc = 0
    kids.forEach((k, i) => {
      const angle = start + ((acc + weights[i] / 2) / total) * span
      acc += weights[i]
      const pos = { x: at.x + ring * Math.cos(angle), y: at.y + ring * Math.sin(angle) }
      placeSubtree(k, pos, angle)
    })
  }

  // ---- roots and their distance from the origin's root ----
  const roots = ids.filter((id) => rootOf(parent, id, known) === id)
  roots.forEach(measure)
  const centre =
    originId !== null && known.has(originId) ? rootOf(parent, originId, known) : roots[0]

  const rootAdj = new Map<number, Set<number>>()
  for (const r of roots) rootAdj.set(r, new Set())
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue
    const a = rootOf(parent, e.source, known)
    const b = rootOf(parent, e.target, known)
    if (a === b) continue
    rootAdj.get(a)!.add(b)
    rootAdj.get(b)!.add(a)
  }
  const dist = new Map<number, number>([[centre, 0]])
  const queue = [centre]
  while (queue.length) {
    const cur = queue.shift()!
    for (const n of [...rootAdj.get(cur)!].sort((a, b) => a - b)) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(cur)! + 1)
        queue.push(n)
      }
    }
  }
  const maxDist = Math.max(0, ...dist.values())
  for (const r of roots) if (!dist.has(r)) dist.set(r, maxDist + 1)

  const rings = new Map<number, number[]>()
  for (const r of roots) {
    const d = dist.get(r)!
    if (!rings.has(d)) rings.set(d, [])
    rings.get(d)!.push(r)
  }

  placeSubtree(centre, { x: 0, y: 0 }, null)
  const rootAngle = new Map<number, number>([[centre, 0]])
  let prevOuter = bubble.get(centre)!

  for (const d of [...rings.keys()].sort((a, b) => a - b)) {
    if (d === 0) continue
    const ring = rings.get(d)!
    // Desired angle: circular mean of already placed neighbours.
    const desired = new Map<number, number>()
    for (const r of ring) {
      let sx = 0
      let sy = 0
      for (const n of rootAdj.get(r)!) {
        const a = rootAngle.get(n)
        if (a !== undefined && n !== centre) {
          sx += Math.cos(a)
          sy += Math.sin(a)
        }
      }
      if (sx !== 0 || sy !== 0) desired.set(r, Math.atan2(sy, sx))
    }
    // Roots with a placed neighbour first, by angle; the rest by id.
    ring.sort((a, b) => {
      const da = desired.get(a)
      const db = desired.get(b)
      if (da !== undefined && db !== undefined) return da - db || a - b
      if (da !== undefined) return -1
      if (db !== undefined) return 1
      return a - b
    })

    const maxBubble = Math.max(...ring.map((r) => bubble.get(r)!))
    const weights = ring.map((r) => 2 * bubble.get(r)! + GAP)
    const total = weights.reduce((a, b) => a + b, 0)
    const radius = Math.max(prevOuter + maxBubble + GAP * 2, total / TAU)

    // Assign arcs in order, then rotate so they sit near their desired angles.
    const assigned: number[] = []
    let acc = 0
    weights.forEach((w) => {
      assigned.push(((acc + w / 2) / total) * TAU)
      acc += w
    })
    let ox = 0
    let oy = 0
    ring.forEach((r, i) => {
      const want = desired.get(r)
      if (want === undefined) return
      ox += Math.cos(want - assigned[i])
      oy += Math.sin(want - assigned[i])
    })
    const offset = ox === 0 && oy === 0 ? -Math.PI / 2 : Math.atan2(oy, ox)
    ring.forEach((r, i) => {
      const angle = assigned[i] + offset
      rootAngle.set(r, angle)
      placeSubtree(r, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }, angle)
    })
    prevOuter = radius + maxBubble
  }

  return out
}

/**
 * Compact the radial seed: springs along edges (short for part_of), a
 * collision push between nodes, a light pull toward the centre, and the
 * origin pinned at (0, 0). Fixed iteration count, so still deterministic.
 */
export function relax(
  seed: Map<number, Point>,
  edges: GraphEdge[],
  originId: number | null,
  radiusOf: (id: number) => number = () => NODE_RADIUS,
) {
  const ids = [...seed.keys()].sort((a, b) => a - b)
  const pos = new Map([...seed].map(([id, p]) => [id, { ...p }]))
  const pinned = originId !== null && pos.has(originId) ? originId : null
  const springs = edges
    .filter((e) => pos.has(e.source) && pos.has(e.target) && e.source !== e.target)
    .map((e) => ({ a: e.source, b: e.target, len: e.kind === 'part_of' ? 210 : 280, k: e.kind === 'part_of' ? 0.08 : 0.03 }))
  const radius = new Map(ids.map((id) => [id, radiusOf(id)]))
  const ITER = 300
  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER
    const force = new Map(ids.map((id) => [id, { x: 0, y: 0 }]))
    for (const s of springs) {
      const p = pos.get(s.a)!
      const q = pos.get(s.b)!
      const dx = q.x - p.x
      const dy = q.y - p.y
      const d = Math.hypot(dx, dy) || 1
      const f = (s.k * (d - s.len)) / d
      force.get(s.a)!.x += dx * f
      force.get(s.a)!.y += dy * f
      force.get(s.b)!.x -= dx * f
      force.get(s.b)!.y -= dy * f
    }
    for (let i = 0; i < ids.length; i++) {
      const p = pos.get(ids[i])!
      for (let j = i + 1; j < ids.length; j++) {
        const q = pos.get(ids[j])!
        let dx = q.x - p.x
        let dy = q.y - p.y
        let d = Math.hypot(dx, dy)
        const minDist = radius.get(ids[i])! + radius.get(ids[j])!
        if (d >= minDist) continue
        if (d === 0) {
          dx = 1
          dy = 0
          d = 1
        }
        const push = ((minDist - d) / d) * 0.5
        force.get(ids[i])!.x -= dx * push
        force.get(ids[i])!.y -= dy * push
        force.get(ids[j])!.x += dx * push
        force.get(ids[j])!.y += dy * push
      }
    }
    for (const id of ids) {
      if (id === pinned) continue
      const p = pos.get(id)!
      const f = force.get(id)!
      p.x += (f.x - p.x * 0.004) * cool
      p.y += (f.y - p.y * 0.004) * cool
    }
  }
  if (pinned !== null) {
    // Keep the origin exactly at the centre.
    const o = pos.get(pinned)!
    for (const p of pos.values()) {
      p.x -= o.x
      p.y -= o.y
    }
  }
  for (const p of pos.values()) {
    p.x = Math.round(p.x)
    p.y = Math.round(p.y)
  }
  return pos
}

function stabilise(
  nodeIds: number[],
  edges: GraphEdge[],
  fresh: Map<number, Point>,
  previous: Map<number, Point>,
): Map<number, Point> {
  const out = new Map<number, Point>()
  for (const id of nodeIds) {
    const p = previous.get(id)
    if (p) out.set(id, p)
  }
  const parent = partOfParents(edges)
  const pending = nodeIds.filter((id) => !out.has(id)).sort((a, b) => a - b)

  const anchorFor = (id: number): number | undefined => {
    const p = parent.get(id)
    if (p !== undefined && out.has(p)) return p
    const neighbour = edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => (e.source === id ? e.target : e.source))
      .filter((n) => out.has(n))
      .sort((a, b) => a - b)[0]
    return neighbour
  }

  // Place children after their anchors: repeat until nothing changes.
  let guard = pending.length + 1
  while (pending.length && guard-- > 0) {
    for (let i = 0; i < pending.length; ) {
      const id = pending[i]
      const anchor = anchorFor(id)
      if (anchor === undefined && guard > 0 && pending.length > 1) {
        i++
        continue
      }
      const f = fresh.get(id)!
      let pos: Point
      if (anchor !== undefined) {
        const fa = fresh.get(anchor)!
        const pa = out.get(anchor)!
        pos = { x: pa.x + (f.x - fa.x), y: pa.y + (f.y - fa.y) }
      } else {
        pos = { ...f }
      }
      out.set(id, nudge(pos, out, id))
      pending.splice(i, 1)
    }
  }
  for (const id of pending) out.set(id, nudge({ ...fresh.get(id)! }, out, id))
  return out
}

/** Push a new point off any existing one closer than two node radii. */
function nudge(pos: Point, placed: Map<number, Point>, self: number): Point {
  const min = NODE_RADIUS * 1.6
  let p = { ...pos }
  for (let iter = 0; iter < 40; iter++) {
    let moved = false
    for (const [id, q] of placed) {
      if (id === self) continue
      const dx = p.x - q.x
      const dy = p.y - q.y
      const d = Math.hypot(dx, dy)
      if (d < min) {
        const ux = d === 0 ? 1 : dx / d
        const uy = d === 0 ? 0 : dy / d
        p = { x: q.x + ux * min, y: q.y + uy * min }
        moved = true
      }
    }
    if (!moved) break
  }
  return p
}
