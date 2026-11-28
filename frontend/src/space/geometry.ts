/** Floating edges: a straight line between two rectangles, cut at their borders. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function border(r: Rect, toward: { x: number; y: number }) {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx)
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

export function floatingLine(a: Rect, b: Rect) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const p = border(a, cb)
  const q = border(b, ca)
  return { sx: p.x, sy: p.y, tx: q.x, ty: q.y }
}

/** Line width for a connection with `n` reasons: 1.5px, growing, capped. */
export function weight(n: number): number {
  return Math.min(9, 1.5 + (n - 1) * 1.75)
}
