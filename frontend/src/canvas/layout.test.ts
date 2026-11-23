import { describe, expect, it } from 'vitest'
import { descendants, layoutCanvas, type Placed, type TreeItem } from './layout'

const item = (id: number, parent_id: number | null, sort_index = id): TreeItem => ({ id, parent_id, sort_index })
const W = 300
const fixed = (h = 100) => () => ({ width: W, height: h })

function overlaps(a: Placed, b: Placed, ha: number, hb: number) {
  return a.x < b.x + W && b.x < a.x + W && a.y < b.y + hb && b.y < a.y + ha
}

describe('canvas layout', () => {
  it('puts the root at the origin', () => {
    const p = layoutCanvas([item(1, null)], 1, fixed())
    expect(p.get(1)).toEqual({ x: -W / 2, y: -50, side: 'root', depth: 0 })
  })

  it('splits the root children: first half right, the rest left', () => {
    const items = [item(1, null), item(2, 1), item(3, 1), item(4, 1), item(5, 1), item(6, 1)]
    const p = layoutCanvas(items, 1, fixed())
    expect([2, 3, 4].map((id) => p.get(id)!.side)).toEqual(['right', 'right', 'right'])
    expect([5, 6].map((id) => p.get(id)!.side)).toEqual(['left', 'left'])
    expect(p.get(2)!.x).toBeGreaterThan(p.get(1)!.x + W)
    expect(p.get(5)!.x + W).toBeLessThan(p.get(1)!.x)
  })

  it('reads clockwise: down the right side, back up the left side', () => {
    const items = [item(1, null), item(2, 1), item(3, 1), item(4, 1), item(5, 1)]
    const p = layoutCanvas(items, 1, fixed())
    expect(p.get(2)!.y).toBeLessThan(p.get(3)!.y) // right: top to bottom
    expect(p.get(5)!.y).toBeLessThan(p.get(4)!.y) // left: 4 then 5, bottom to top
  })

  it('orders siblings by sort_index, not id', () => {
    const items = [item(1, null), item(2, 1, 0), item(3, 2, 5), item(4, 2, 1)]
    const p = layoutCanvas(items, 1, fixed())
    expect(p.get(4)!.y).toBeLessThan(p.get(3)!.y)
  })

  it('centres a parent on its children and never overlaps nodes', () => {
    const items = [item(1, null), item(2, 1), item(3, 1)]
    for (let id = 4; id < 14; id++) items.push(item(id, id % 3 === 0 ? 2 : id - 1 > 3 ? id - 1 : 3))
    const heights = new Map(items.map((i) => [i.id, 60 + ((i.id * 37) % 140)]))
    const size = (id: number) => ({ width: W, height: heights.get(id)! })
    const p = layoutCanvas(items, 1, size)
    expect(p.size).toBe(items.length)
    const all = [...p.entries()]
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [a, pa] = all[i]
        const [b, pb] = all[j]
        expect(overlaps(pa, pb, heights.get(a)!, heights.get(b)!), `${a} overlaps ${b}`).toBe(false)
      }
    const kids = items.filter((i) => i.parent_id === 2).map((i) => p.get(i.id)!)
    const top = Math.min(...kids.map((k) => k.y))
    const bottom = Math.max(...kids.map((k, n) => k.y + heights.get(items.filter((i) => i.parent_id === 2)[n].id)!))
    const parentCentre = p.get(2)!.y + heights.get(2)! / 2
    expect(Math.abs(parentCentre - (top + bottom) / 2)).toBeLessThan(1)
  })

  it('places deeper levels further out on their side', () => {
    const items = [item(1, null), item(2, 1), item(3, 1), item(4, 2), item(5, 3)]
    const p = layoutCanvas(items, 1, fixed())
    expect(p.get(4)!.x).toBeGreaterThan(p.get(2)!.x)
    expect(p.get(5)!.x).toBeLessThan(p.get(3)!.x)
    expect(p.get(5)!.depth).toBe(2)
  })

  it('leaves out the children of collapsed nodes', () => {
    const items = [item(1, null), item(2, 1), item(3, 2), item(4, 3)]
    const p = layoutCanvas(items, 1, fixed(), { collapsed: new Set([2]) })
    expect([...p.keys()].sort()).toEqual([1, 2])
    expect(descendants(items, 2).sort()).toEqual([3, 4])
  })
})
