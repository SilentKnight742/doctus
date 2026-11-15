import { describe, expect, it } from 'vitest'
import type { EdgeKind, GraphEdge } from '../api/types'
import { collapse, levelForZoom } from './zoom'

let nextId = 1
const e = (source: number, target: number, kind: EdgeKind): GraphEdge => ({
  id: nextId++,
  source,
  target,
  kind,
  reason: '',
})

// 1 origin; 2 "Regions" with parts 3, 4; 5 part of 3; 6 standalone.
const ids = [1, 2, 3, 4, 5, 6]
const edges = [
  e(3, 2, 'part_of'),
  e(4, 2, 'part_of'),
  e(5, 3, 'part_of'),
  e(1, 2, 'prerequisite'),
  e(1, 3, 'prerequisite'),
  e(1, 4, 'prerequisite'),
  e(5, 6, 'related'),
  e(6, 4, 'related'),
]

describe('levelForZoom', () => {
  it('maps zoom to three levels', () => {
    expect(levelForZoom(0.3)).toBe('overview')
    expect(levelForZoom(0.7)).toBe('topics')
    expect(levelForZoom(1.2)).toBe('detail')
  })

  it('does not flip right at a threshold', () => {
    expect(levelForZoom(0.57, 'overview')).toBe('overview')
    expect(levelForZoom(0.61, 'overview')).toBe('topics')
    expect(levelForZoom(0.97, 'detail')).toBe('detail')
    expect(levelForZoom(0.9, 'detail')).toBe('topics')
  })
})

describe('collapse', () => {
  it('shows everything at detail', () => {
    const c = collapse(ids, edges, 'detail')
    expect(c.nodes.map((n) => n.id)).toEqual(ids)
    expect(c.nodes.every((n) => n.hidden === 0)).toBe(true)
    expect(c.edges).toHaveLength(edges.length)
  })

  it('folds parts into their roots at overview', () => {
    const c = collapse(ids, edges, 'overview')
    expect(c.nodes).toEqual([
      { id: 1, hidden: 0 },
      { id: 2, hidden: 3 },
      { id: 6, hidden: 0 },
    ])
    expect(c.rep.get(5)).toBe(2)
  })

  it('merges parallel edges and drops edges inside a group', () => {
    const c = collapse(ids, edges, 'overview')
    const prereq = c.edges.find((m) => m.kind === 'prerequisite')!
    expect(prereq).toMatchObject({ source: 1, target: 2, count: 3 })
    expect(c.edges.some((m) => m.kind === 'part_of')).toBe(false)
    // 5-6 and 6-4 both become 2-6 related (undirected), merged.
    const rel = c.edges.filter((m) => m.kind === 'related')
    expect(rel).toHaveLength(1)
    expect(rel[0]).toMatchObject({ source: 2, target: 6, count: 2 })
  })

  it('keeps depth 1 at topics', () => {
    const c = collapse(ids, edges, 'topics')
    expect(c.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 6])
    expect(c.nodes.find((n) => n.id === 3)!.hidden).toBe(1)
    expect(c.rep.get(5)).toBe(3)
  })
})
