/**
 * The one canvas layout: branches on both sides of the root, read clockwise.
 *
 * The root's children are split in two: the first half goes down the right
 * side, the rest comes back up the left side. The left side is the right
 * side's layout turned half a circle (mirrored left-right, siblings in
 * reverse order top-to-bottom), so reading the whole canvas clockwise from
 * the top right visits branches in their order.
 *
 * Each side is a tidy tree: a node is centred vertically on the block of its
 * children, and sibling subtrees are stacked without overlapping. Sizes come
 * from the rendered cards (React Flow's measured sizes), with an estimate
 * before the first measure.
 */

export interface TreeItem {
  id: number
  parent_id: number | null
  sort_index: number
}

export interface Size {
  width: number
  height: number
}

export type Side = 'root' | 'right' | 'left'

export interface Placed {
  /** Top-left corner, in flow coordinates. */
  x: number
  y: number
  side: Side
  depth: number
}

export interface LayoutOptions {
  /** Horizontal gap between a node and its children. */
  gapX?: number
  /** Vertical gap between sibling subtrees. */
  gapY?: number
  /** Nodes whose children are hidden (collapsed branches). */
  collapsed?: ReadonlySet<number>
}

export const GAP_X = 96
export const GAP_Y = 28

export function childrenByParent<T extends TreeItem>(items: readonly T[]): Map<number, T[]> {
  const kids = new Map<number, T[]>()
  for (const it of items) {
    if (it.parent_id === null) continue
    const list = kids.get(it.parent_id) ?? []
    list.push(it)
    kids.set(it.parent_id, list)
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort_index - b.sort_index || a.id - b.id)
  return kids
}

/** The root's children that go on the right side (the rest go left). */
export function rightCount(n: number): number {
  return Math.ceil(n / 2)
}

export function layoutCanvas(
  items: readonly TreeItem[],
  rootId: number,
  size: (id: number) => Size,
  { gapX = GAP_X, gapY = GAP_Y, collapsed }: LayoutOptions = {},
): Map<number, Placed> {
  const out = new Map<number, Placed>()
  if (!items.some((i) => i.id === rootId)) return out
  const kidsOf = childrenByParent(items)
  const visibleKids = (id: number, side: Side) => {
    if (collapsed?.has(id)) return []
    const list = kidsOf.get(id) ?? []
    return side === 'left' ? [...list].reverse() : list
  }

  const heights = new Map<number, number>()
  const subtreeHeight = (id: number, side: Side): number => {
    const known = heights.get(id)
    if (known !== undefined) return known
    const kids = visibleKids(id, side)
    const block = kids.reduce((sum, k) => sum + subtreeHeight(k.id, side), 0) + gapY * Math.max(0, kids.length - 1)
    const h = Math.max(size(id).height, block)
    heights.set(id, h)
    return h
  }

  /** Place a subtree whose band starts at `top`; `edge` is the x of the side facing the parent. */
  const place = (id: number, side: Side, edge: number, top: number, depth: number) => {
    const s = size(id)
    const band = subtreeHeight(id, side)
    const centre = top + band / 2
    const x = side === 'left' ? edge - s.width : edge
    out.set(id, { x, y: centre - s.height / 2, side, depth })
    const kids = visibleKids(id, side)
    const block = kids.reduce((sum, k) => sum + subtreeHeight(k.id, side), 0) + gapY * Math.max(0, kids.length - 1)
    const kidEdge = side === 'left' ? x - gapX : x + s.width + gapX
    let y = centre - block / 2
    for (const k of kids) {
      place(k.id, side, kidEdge, y, depth + 1)
      y += subtreeHeight(k.id, side) + gapY
    }
  }

  const root = size(rootId)
  out.set(rootId, { x: -root.width / 2, y: -root.height / 2, side: 'root', depth: 0 })
  if (collapsed?.has(rootId)) return out
  const top = kidsOf.get(rootId) ?? []
  const cut = rightCount(top.length)
  const sides: [Side, TreeItem[], number][] = [
    ['right', top.slice(0, cut), root.width / 2 + gapX],
    ['left', top.slice(cut).reverse(), -root.width / 2 - gapX],
  ]
  for (const [side, list, edge] of sides) {
    const block = list.reduce((sum, k) => sum + subtreeHeight(k.id, side), 0) + gapY * Math.max(0, list.length - 1)
    let y = -block / 2
    for (const k of list) {
      place(k.id, side, edge, y, 1)
      y += subtreeHeight(k.id, side) + gapY
    }
  }
  return out
}

/** Ids of every node under `id` (not including it). */
export function descendants(items: readonly TreeItem[], id: number): number[] {
  const kidsOf = childrenByParent(items)
  const out: number[] = []
  const stack = [...(kidsOf.get(id) ?? [])]
  while (stack.length) {
    const n = stack.pop()!
    out.push(n.id)
    stack.push(...(kidsOf.get(n.id) ?? []))
  }
  return out
}
