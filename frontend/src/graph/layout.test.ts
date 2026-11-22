import { describe, expect, it } from 'vitest'
import type { EdgeKind, GraphEdge } from '../api/types'
import { layout, NODE_RADIUS } from './layout'

let nextId = 1
const e = (source: number, target: number, kind: EdgeKind): GraphEdge => ({
  id: nextId++,
  source,
  target,
  kind,
  reason: '',
})

const ids = [1, 2, 3, 4, 5, 6, 7]
const edges = [
  e(1, 2, 'prerequisite'),
  e(3, 2, 'part_of'),
  e(4, 2, 'part_of'),
  e(5, 2, 'part_of'),
  e(1, 6, 'related'),
  e(6, 7, 'prerequisite'),
]
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

describe('layout', () => {
  it('puts the origin at the centre', () => {
    expect(layout(ids, edges, 1).get(1)).toEqual({ x: 0, y: 0 })
  })

  it('is deterministic', () => {
    expect([...layout(ids, edges, 1)]).toEqual([...layout([...ids].reverse(), edges, 1)])
  })

  it('keeps part_of children near their parent', () => {
    const p = layout(ids, edges, 1)
    for (const child of [3, 4, 5]) {
      expect(dist(p.get(child)!, p.get(2)!)).toBeLessThan(dist(p.get(child)!, p.get(1)!))
    }
  })

  it('does not overlap nodes', () => {
    const p = [...layout(ids, edges, 1).values()]
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++) expect(dist(p[i], p[j])).toBeGreaterThan(NODE_RADIUS)
  })

  it('keeps existing positions when a node is added', () => {
    const before = layout(ids, edges, 1)
    const after = layout([...ids, 8], [...edges, e(8, 2, 'part_of')], 1, before)
    for (const id of ids) expect(after.get(id)).toEqual(before.get(id))
    expect(dist(after.get(8)!, after.get(2)!)).toBeLessThan(dist(after.get(8)!, after.get(1)!))
  })
})
