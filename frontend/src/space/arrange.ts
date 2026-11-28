/*
 * "Arrange" on the space canvas: place nodes on a staggered grid so that
 * connection lines cross as little as possible, then keep them short and away
 * from other nodes. A small local search (swap two slots, keep it if no
 * worse), with a fixed seed so the same space always arranges the same way.
 */
import type { Id } from '../api/types'

export interface ArrangeNode {
  id: Id
  x: number
  y: number
}
export interface ArrangeEdge {
  a: Id
  b: Id
  weight: number
}
interface P {
  x: number
  y: number
}

const CROSSING = 1000
const NEAR_NODE = 250

function cross(o: P, a: P, b: P) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/** Do segments pq and rs cross (strictly, not just touch at an end)? */
export function segmentsCross(p: P, q: P, r: P, s: P): boolean {
  const d1 = cross(r, s, p)
  const d2 = cross(r, s, q)
  const d3 = cross(p, q, r)
  const d4 = cross(p, q, s)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function distToSegment(c: P, p: P, q: P) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / len))
  return Math.hypot(c.x - (p.x + t * dx), c.y - (p.y + t * dy))
}

/** Number of pairs of lines (not sharing a node) that cross. */
export function crossings(pos: Map<Id, P>, edges: ArrangeEdge[]): number {
  let n = 0
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i]
      const f = edges[j]
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue
      if (segmentsCross(pos.get(e.a)!, pos.get(e.b)!, pos.get(f.a)!, pos.get(f.b)!)) n++
    }
  return n
}

/** Layout cost: crossings dominate, then weighted length, then lines running through other nodes. */
function cost(at: P[], edges: [number, number, number][], gap: number) {
  let c = 0
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i]
      const [d, e] = edges[j]
      if (a === d || a === e || b === d || b === e) continue
      if (segmentsCross(at[a], at[b], at[d], at[e])) c += CROSSING
    }
  for (const [a, b, w] of edges) {
    const p = at[a]
    const q = at[b]
    c += (w * Math.hypot(p.x - q.x, p.y - q.y)) / gap
    // A line that runs through a third node reads as a link to it.
    for (let k = 0; k < at.length; k++)
      if (k !== a && k !== b && distToSegment(at[k], p, q) < gap * 0.3) c += NEAR_NODE
  }
  return c
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * New positions (top-left corners) for `nodes`. `gapX`/`gapY` are the slot
 * spacing; odd rows are shifted by half a slot so no three slots line up in
 * a column.
 */
export function arrange(nodes: ArrangeNode[], edges: ArrangeEdge[], gapX = 300, gapY = 170): Map<Id, P> {
  const n = nodes.length
  if (n === 0) return new Map()
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.5)))
  const rows = Math.ceil((n + Math.max(1, Math.floor(n / 3))) / cols)
  const slots: P[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) slots.push({ x: c * gapX + (r % 2 ? gapX / 2 : 0), y: r * gapY })

  // Start from the current reading order (top to bottom, left to right).
  const order = [...nodes].sort((p, q) => p.y - q.y || p.x - q.x).map((x) => x.id)
  const index = new Map(order.map((id, i) => [id, i]))
  const live: [number, number, number][] = edges
    .filter((e) => e.a !== e.b && index.has(e.a) && index.has(e.b))
    .map((e) => [index.get(e.a)!, index.get(e.b)!, e.weight])

  // slotOf[node] = slot index; positions follow from it.
  const at = (slotOf: number[]) => slotOf.map((k) => slots[k])
  const rand = rng(7)
  let best = order.map((_, i) => i)
  let bestCost = cost(at(best), live, gapX)
  for (let restart = 0; restart < 5; restart++) {
    const cur = restart === 0 ? [...best] : shuffle(slots.length, rand).slice(0, n)
    const pos = at(cur)
    let curCost = cost(pos, live, gapX)
    for (let it = 0; it < 700; it++) {
      // Move one node to another slot, swapping with whoever is there.
      const i = Math.floor(rand() * n)
      const k = Math.floor(rand() * slots.length)
      if (cur[i] === k) continue
      const j = cur.indexOf(k)
      const old = cur[i]
      cur[i] = k
      pos[i] = slots[k]
      if (j >= 0) {
        cur[j] = old
        pos[j] = slots[old]
      }
      const c = cost(pos, live, gapX)
      if (c <= curCost) curCost = c
      else {
        cur[i] = old
        pos[i] = slots[old]
        if (j >= 0) {
          cur[j] = k
          pos[j] = slots[k]
        }
      }
    }
    if (curCost < bestCost) {
      best = [...cur]
      bestCost = curCost
    }
  }

  // Shift so the layout starts at the origin.
  const placed = at(best)
  const minX = Math.min(...placed.map((p) => p.x))
  const minY = Math.min(...placed.map((p) => p.y))
  return new Map(order.map((id, i) => [id, { x: placed[i].x - minX, y: placed[i].y - minY }]))
}

function shuffle(n: number, rand: () => number) {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
