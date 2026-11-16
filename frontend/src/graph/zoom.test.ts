import { describe, expect, it } from 'vitest'
import type { EdgeKind, GraphEdge } from '../api/types'
import { DEFAULT_SIZE as P, dMaxFor, group, groupSize, mergeEdges, minZoom, nodeSize, zoomDepths } from './zoom'

let nextId = 1
const e = (source: number, target: number, kind: EdgeKind): GraphEdge => ({
  id: nextId++,
  source,
  target,
  kind,
  reason: '',
})

// 1 origin (root); 2 Regions (root) > 3 Kanto > 5 Bulbasaur > 7 Ivysaur;
// 2 > 4 Johto; 6 Type triangle (root).
const ids = [1, 2, 3, 4, 5, 6, 7]
const edges = [
  e(3, 2, 'part_of'),
  e(4, 2, 'part_of'),
  e(5, 3, 'part_of'),
  e(7, 5, 'part_of'),
  e(1, 2, 'prerequisite'),
  e(1, 3, 'prerequisite'),
  e(1, 4, 'prerequisite'),
  e(6, 5, 'related'),
  e(6, 4, 'related'),
]

describe('sizes', () => {
  it('shrinks by r per part_of level', () => {
    expect(nodeSize(0, P)).toBe(160)
    expect(nodeSize(1, P)).toBe(120)
    expect(nodeSize(2, P)).toBe(90)
  })

  it('clamps min zoom to MIN / S0, where only depth 0 is readable', () => {
    expect(minZoom(P)).toBeCloseTo(0.3)
    expect(dMaxFor(minZoom(P), P)).toBe(0)
  })

  it('grows groups with sqrt(count), capped', () => {
    expect(groupSize(0, 0, P)).toBe(160)
    expect(groupSize(0, 4, P)).toBeCloseTo(160 * 1.4)
    expect(groupSize(0, 100, P)).toBe(160 * P.groupCap)
  })
})

describe('dMaxFor', () => {
  it('gives the deepest readable level for a zoom', () => {
    // S(d) * zoom >= 48
    expect(dMaxFor(1.0, P)).toBe(4) // 160 * 0.75^4 = 50.6
    expect(dMaxFor(0.6, P)).toBe(2) // 54 at d=2, 40.5 at d=3
    expect(dMaxFor(0.4, P)).toBe(1) // 48 at d=1
    expect(dMaxFor(0.3, P)).toBe(0)
  })

  it('merges below MIN but splits only above MIN * 1.15', () => {
    // Depth 1 is 120 px: on screen at 120 * z.
    const zMerge = 47 / 120 // just below MIN
    const zBetween = 52 / 120 // above MIN, below MIN * 1.15 = 55.2
    const zSplit = 56 / 120 // above MIN * 1.15
    expect(dMaxFor(zMerge, P, 1)).toBe(0) // merges
    expect(dMaxFor(zBetween, P, 0)).toBe(0) // stays merged
    expect(dMaxFor(zBetween, P, 1)).toBe(1) // stays split
    expect(dMaxFor(zSplit, P, 0)).toBe(1) // splits
  })

  it('can jump several levels at once', () => {
    expect(dMaxFor(1.0, P, 0)).toBe(3) // 4th level is 50.6 px, below 55.2: not yet
    expect(dMaxFor(0.3, P, 4)).toBe(0)
  })
})

describe('group', () => {
  it('merges into the nearest visible ancestor', () => {
    const g = group(ids, edges, 1, P)
    expect(g.rep.get(5)).toBe(3) // Bulbasaur -> Kanto (depth 1), not Regions
    expect(g.rep.get(7)).toBe(3) // Ivysaur -> Kanto too
    expect(g.rep.get(4)).toBe(4)
    const kanto = g.nodes.find((n) => n.id === 3)!
    expect(kanto.merged).toBe(2)
    expect(kanto.size).toBeCloseTo(groupSize(1, 2, P))
  })

  it('never merges nodes without a part_of parent', () => {
    const g = group(ids, edges, 0, P)
    for (const root of [1, 2, 6]) expect(g.rep.get(root)).toBe(root)
    expect(g.rep.get(7)).toBe(2)
  })

  it('shows everything when deep enough', () => {
    const g = group(ids, edges, 10, P)
    expect(g.nodes.every((n) => n.rep === n.id && n.merged === 0)).toBe(true)
    expect(g.edges).toHaveLength(edges.length)
  })

  it('drops internal edges and merges parallels', () => {
    const g = group(ids, edges, 0, P)
    expect(g.edges.some((m) => m.kind === 'part_of')).toBe(false)
    expect(g.edges.find((m) => m.kind === 'prerequisite')).toMatchObject({ source: 1, target: 2, count: 3 })
    const rel = g.edges.filter((m) => m.kind === 'related')
    expect(rel).toEqual([expect.objectContaining({ source: 2, target: 6, count: 2 })])
  })

  it('treats related as undirected when merging', () => {
    const rep = new Map([
      [1, 1],
      [2, 2],
    ])
    const merged = mergeEdges([e(1, 2, 'related'), e(2, 1, 'related')], rep)
    expect(merged).toHaveLength(1)
    expect(merged[0].count).toBe(2)
  })

  it('keeps the origin and its direct parts at depth 0', () => {
    // 1 origin > 2 Kanto (part of origin) > 3 Bulbasaur; 4 is a separate root.
    const es = [e(2, 1, 'part_of'), e(3, 2, 'part_of'), e(4, 2, 'related')]
    const d = zoomDepths([1, 2, 3, 4], es, 1)
    expect([d.get(1), d.get(2), d.get(3), d.get(4)]).toEqual([0, 0, 1, 0])
    const g = group([1, 2, 3, 4], es, 0, P, 1)
    expect(g.rep.get(2)).toBe(2) // never merges into the origin
    expect(g.rep.get(3)).toBe(2) // nearest visible ancestor
    // Without the origin rule the whole graph would fold into the origin.
    expect(group([1, 2, 3, 4], es, 0, P).rep.get(3)).toBe(1)
  })
})
