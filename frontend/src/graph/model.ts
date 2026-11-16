import type { GraphEdge } from '../api/types'

/** part_of parent of each node (child -> parent). Keeps the first if several. */
export function partOfParents(edges: GraphEdge[]): Map<number, number> {
  const parent = new Map<number, number>()
  for (const e of [...edges].sort((a, b) => a.id - b.id)) {
    if (e.kind === 'part_of' && !parent.has(e.source) && e.source !== e.target) {
      parent.set(e.source, e.target)
    }
  }
  // Defensive: break any cycle the server should already have prevented.
  for (const start of parent.keys()) {
    const seen = new Set<number>([start])
    let cur = parent.get(start)
    while (cur !== undefined) {
      if (seen.has(cur)) {
        parent.delete(start)
        break
      }
      seen.add(cur)
      cur = parent.get(cur)
    }
  }
  return parent
}

export function childrenOf(parent: Map<number, number>, ids: number[]): Map<number, number[]> {
  const known = new Set(ids)
  const children = new Map<number, number[]>()
  for (const id of [...ids].sort((a, b) => a - b)) {
    const p = parent.get(id)
    if (p === undefined || !known.has(p)) continue
    if (!children.has(p)) children.set(p, [])
    children.get(p)!.push(id)
  }
  return children
}

/** Depth below the part_of root (roots are 0). */
export function depths(parent: Map<number, number>, ids: number[]): Map<number, number> {
  const known = new Set(ids)
  const out = new Map<number, number>()
  const depthOf = (id: number): number => {
    const cached = out.get(id)
    if (cached !== undefined) return cached
    const p = parent.get(id)
    const d = p === undefined || !known.has(p) ? 0 : depthOf(p) + 1
    out.set(id, d)
    return d
  }
  ids.forEach(depthOf)
  return out
}

export function rootOf(parent: Map<number, number>, id: number, known: Set<number>): number {
  let cur = id
  for (;;) {
    const p = parent.get(cur)
    if (p === undefined || !known.has(p)) return cur
    cur = p
  }
}
