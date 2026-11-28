import { describe, expect, it } from 'vitest'
import { floatingLine, weight } from './geometry'

describe('floatingLine', () => {
  it('cuts the line at both borders', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 }
    const b = { x: 300, y: 0, w: 100, h: 50 }
    expect(floatingLine(a, b)).toEqual({ sx: 100, sy: 25, tx: 300, ty: 25 })
  })

  it('works vertically and for overlapping centres', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 }
    expect(floatingLine(a, { x: 0, y: 200, w: 100, h: 50 })).toEqual({ sx: 50, sy: 50, tx: 50, ty: 200 })
    expect(floatingLine(a, a)).toEqual({ sx: 50, sy: 25, tx: 50, ty: 25 })
  })
})

describe('weight', () => {
  it('grows with the reason count and is capped', () => {
    expect(weight(1)).toBe(1.5)
    expect(weight(2)).toBeGreaterThan(weight(1))
    expect(weight(50)).toBe(9)
  })
})
