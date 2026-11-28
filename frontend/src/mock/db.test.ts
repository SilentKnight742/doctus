import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { decisionType } from '../schema/custom'
import { Db } from './db'

function setup() {
  const db = new Db(undefined, () => 1000)
  const space = db.createSpace('S')
  const a = db.createWorld(space.id, { title: 'A' })
  const b = db.createWorld(space.id, { title: 'B' })
  const c = db.createWorld(space.id, { title: 'C' })
  const note = (worldId: number, title: string) => db.createWidget({ world_id: worldId, type: 'note', data: { title } })
  const [a1, a2, b1, c1] = [note(a.id, 'a1'), note(a.id, 'a2'), note(b.id, 'b1'), note(c.id, 'c1')]
  const link = (x: number, y: number, author: 'ai' | 'user' = 'ai') =>
    db.createReason({ widget_a: x, widget_b: y, kind: 'informs', text: 'because', author })
  return { db, space, a, b, c, a1, a2, b1, c1, link }
}

function status(fn: () => unknown): number | null {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) return e.status
    throw e
  }
  return null
}

describe('widgets', () => {
  it('are validated against their type on create and update', () => {
    const { db, a, a1 } = setup()
    expect(status(() => db.createWidget({ world_id: a.id, type: 'note', data: { title: '' } }))).toBe(422)
    expect(status(() => db.createWidget({ world_id: a.id, type: 'nope', data: {} }))).toBe(422)
    expect(status(() => db.createWidget({ world_id: 999, type: 'note', data: { title: 'x' } }))).toBe(404)
    expect(status(() => db.updateWidget(a1.id, { data: { body: 42 as unknown as string } }))).toBe(422)
    expect(db.widget(a1.id).data.body).toBe('')
    db.updateWidget(a1.id, { data: { body: 'hi' } })
    expect(db.widget(a1.id).data).toEqual({ title: 'a1', body: 'hi' })
  })

  it('may use a type defined on their space only', () => {
    const { db, space, a } = setup()
    expect(status(() => db.createWidget({ world_id: a.id, type: 'decision', data: { question: 'Q' } }))).toBe(422)
    db.defineType(decisionType(space.id))
    expect(db.createWidget({ world_id: a.id, type: 'decision', data: { question: 'Q' } }).data.status).toBe('Open')
    const other = db.createSpace('Other')
    const w = db.createWorld(other.id, { title: 'W' })
    expect(status(() => db.createWidget({ world_id: w.id, type: 'decision', data: { question: 'Q' } }))).toBe(422)
  })

  it('can live at space level, without a world', () => {
    const { db, space } = setup()
    const w = db.createWidget({ space_id: space.id, world_id: null, type: 'note', data: { title: 'top' } })
    expect(db.spaceView(space.id).space_widgets.map((x) => x.id)).toEqual([w.id])
  })
})

describe('reasons (the evidence rule)', () => {
  it('need two existing, different widgets in worlds of one space', () => {
    const { db, space, a1, b1, link } = setup()
    expect(status(() => link(a1.id, 999))).toBe(422)
    expect(status(() => link(a1.id, a1.id))).toBe(422)
    const other = db.createSpace('O')
    const ow = db.createWidget({ world_id: db.createWorld(other.id, { title: 'X' }).id, type: 'note', data: { title: 'x' } })
    expect(status(() => link(a1.id, ow.id))).toBe(422)
    const top = db.createWidget({ space_id: space.id, type: 'note', data: { title: 't' } })
    expect(status(() => link(a1.id, top.id))).toBe(422)
    expect(status(() => db.createReason({ widget_a: a1.id, widget_b: b1.id, kind: ' ', text: 'x', author: 'ai' }))).toBe(422)
    expect(status(() => db.createReason({ widget_a: a1.id, widget_b: b1.id, kind: 'k', text: 'x', author: 'bot' as 'ai' }))).toBe(422)
    expect(db.state.reasons).toHaveLength(0)
    expect(link(a1.id, b1.id, 'user').author).toBe('user')
  })

  it('are deleted with their widget; a connection without reasons disappears', () => {
    const { db, space, a1, b1, c1, link } = setup()
    link(a1.id, b1.id)
    link(b1.id, c1.id)
    expect(db.connections(space.id)).toHaveLength(2)
    db.deleteWidget(b1.id)
    expect(db.state.reasons).toHaveLength(0)
    expect(db.connections(space.id)).toEqual([])
  })

  it('are deleted with their world', () => {
    const { db, space, a, a1, b1, c1, link } = setup()
    link(a1.id, b1.id)
    link(b1.id, c1.id)
    db.deleteWorld(a.id)
    expect(db.state.widgets.some((w) => w.world_id === a.id)).toBe(false)
    expect(db.connections(space.id).map((c) => c.reason_count)).toEqual([1])
  })
})

describe('connections', () => {
  it('are one per pair of worlds, counting reasons in both directions', () => {
    const { db, space, a, b, a1, a2, b1, c1, link } = setup()
    link(a1.id, b1.id)
    link(b1.id, a2.id)
    link(a1.id, a2.id) // same world: no connection
    link(c1.id, a1.id)
    const conns = db.connections(space.id)
    expect(conns.map((c) => [c.key, c.reason_count])).toEqual([
      [`${a.id}-${b.id}`, 2],
      [`${a.id}-${a.id + 2}`, 1],
    ])
    const view = db.connectionView(b.id, a.id)
    expect(view.worlds.map((w) => w.id)).toEqual([a.id, b.id])
    expect(view.reasons).toHaveLength(2)
    expect(view.reasons[0].a.title).toBe('a1')
    expect(status(() => db.connectionView(b.id, b.id + 1))).toBe(404)
  })
})

describe('new world from selection', () => {
  it('copies the referenced widgets, keeping copied_from and the selected reasons', () => {
    const { db, space, a1, b1, c1, link } = setup()
    const r1 = link(a1.id, b1.id)
    const r2 = link(b1.id, c1.id)
    const w = db.newWorldFromSelection({ space_id: space.id, reason_ids: [r1.id, r2.id], title: 'New', mode: 'copy' })
    const copies = db.state.widgets.filter((x) => x.world_id === w.id)
    expect(copies.map((x) => x.copied_from)).toEqual([a1.id, b1.id, c1.id])
    expect(copies.map((x) => x.data.title)).toEqual(['a1', 'b1', 'c1'])
    // originals untouched, selected reasons copied between the copies
    expect(db.widget(a1.id).world_id).toBe(a1.world_id)
    expect(db.state.reasons).toHaveLength(4)
    expect(db.worldView(w.id).reasons).toHaveLength(2)
    // copies are linked to each other inside the new world, so no new connection
    expect(db.connections(space.id)).toHaveLength(2)
  })

  it('moves the widgets with all their reasons', () => {
    const { db, space, a, a1, b1, c1, link } = setup()
    const r1 = link(a1.id, b1.id)
    link(b1.id, c1.id)
    const w = db.newWorldFromSelection({ space_id: space.id, reason_ids: [r1.id], title: 'Moved', mode: 'move' })
    expect(db.widget(a1.id).world_id).toBe(w.id)
    expect(db.widget(b1.id).world_id).toBe(w.id)
    expect(db.state.widgets.filter((x) => x.world_id === w.id)).toHaveLength(2)
    expect(db.state.reasons).toHaveLength(2)
    // r1 is now inside one world; b1–c1 connects the new world to C
    const keys = db.connections(space.id).map((c) => c.key)
    expect(keys).toEqual([`${c1.world_id}-${w.id}`])
    expect(db.state.widgets.some((x) => x.world_id === a.id && x.id === a1.id)).toBe(false)
  })

  it('rejects an empty selection or a bad mode', () => {
    const { db, space, a1, b1, link } = setup()
    const r = link(a1.id, b1.id)
    expect(status(() => db.newWorldFromSelection({ space_id: space.id, reason_ids: [], title: 'X', mode: 'copy' }))).toBe(422)
    expect(status(() => db.newWorldFromSelection({ space_id: space.id, reason_ids: [r.id], title: 'X', mode: 'clone' as 'copy' }))).toBe(422)
    expect(status(() => db.newWorldFromSelection({ space_id: space.id, reason_ids: [999], title: 'X', mode: 'copy' }))).toBe(404)
    expect(status(() => db.newWorldFromSelection({ space_id: space.id, reason_ids: [r.id], title: '  ', mode: 'copy' }))).toBe(422)
  })
})

describe('bad input', () => {
  it('never throws anything but an ApiError', () => {
    const { db, space, a, a1 } = setup()
    const junk: unknown[] = [undefined, null, '', 'x', -1, 1e9, NaN, [], {}, { title: {} }]
    const calls: ((v: never) => unknown)[] = [
      (v) => db.createSpace(v),
      (v) => db.createWorld(space.id, v),
      (v) => db.createWorld(v, { title: 'x' }),
      (v) => db.updateWorld(a.id, v ?? {}),
      (v) => db.createWidget(v ?? {}),
      (v) => db.createWidget({ world_id: a.id, type: 'note', data: v }),
      (v) => db.updateWidget(a1.id, { data: v, x: v }),
      (v) => db.createReason(v ?? {}),
      (v) => db.updateReason(v, {}),
      (v) => db.newWorldFromSelection(v ?? {}),
      (v) => db.connectionView(v, v),
    ]
    for (const call of calls)
      for (const v of junk) {
        try {
          call(v as never)
        } catch (e) {
          expect(e, String(call)).toBeInstanceOf(ApiError)
        }
      }
  })
})
