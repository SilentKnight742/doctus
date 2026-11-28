import { describe, expect, it } from 'vitest'
import { arrange, crossings, segmentsCross, type ArrangeEdge } from './arrange'

describe('arrange', () => {
  it('detects crossing segments', () => {
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true)
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false)
  })

  it('untangles a crossed cycle', () => {
    // A square drawn as a bow tie: 1-2-3-4-1 with 1,3 and 2,4 adjacent.
    const nodes = [
      { id: 1, x: 0, y: 0 },
      { id: 3, x: 300, y: 0 },
      { id: 2, x: 300, y: 300 },
      { id: 4, x: 0, y: 300 },
    ]
    const edges: ArrangeEdge[] = [
      { a: 1, b: 2, weight: 1 },
      { a: 2, b: 3, weight: 1 },
      { a: 3, b: 4, weight: 1 },
      { a: 4, b: 1, weight: 1 },
    ]
    const before = new Map(nodes.map((n) => [n.id, n]))
    expect(crossings(before, edges)).toBe(1)
    const after = arrange(nodes, edges)
    expect(after.size).toBe(4)
    expect(crossings(after, edges)).toBe(0)
  })

  it('gives every node its own place and is deterministic', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, x: i * 10, y: 0 }))
    const edges: ArrangeEdge[] = [
      [1, 2], [1, 3], [1, 4], [2, 5], [3, 5], [4, 6], [5, 6], [6, 7], [2, 7], [3, 4],
    ].map(([a, b]) => ({ a, b, weight: 1 }))
    const a = arrange(nodes, edges)
    const keys = new Set([...a.values()].map((p) => `${p.x},${p.y}`))
    expect(keys.size).toBe(7)
    expect(arrange(nodes, edges)).toEqual(a)
    expect(crossings(a, edges)).toBeLessThanOrEqual(1)
  })
})
