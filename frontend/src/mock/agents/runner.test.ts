import { describe, expect, it } from 'vitest'
import { Db } from '../db'
import { seedState, SEED_SPACE_TITLE } from '../seed'
import { SCRIPTS } from './petstore'
import { answer, findScript, instantPace, suggestionsFor, type Script } from './runner'
import { runTool } from './tools'

async function seeded() {
  const db = new Db(await seedState(() => 1000), () => 1000)
  const space = db.state.spaces.find((s) => s.title === SEED_SPACE_TITLE)!
  const empty = db.state.spaces.find((s) => s.id !== space.id)!
  return { db, space, empty }
}

describe('seed (the headline script played instantly)', () => {
  it('builds six worlds, a custom type in use, a tracker and 15 reasons', async () => {
    const { db, space } = await seeded()
    const view = db.spaceView(space.id)
    expect(view.worlds.map((w) => w.title)).toEqual([
      'Pets endpoints',
      'Store / orders',
      'Users / auth',
      'Checkout flow design',
      'Open decisions',
      'Metrics & feedback',
    ])
    expect(view.widget_types.filter((t) => !t.builtin).map((t) => t.name)).toEqual(['decision', 'tracker'])
    expect(db.state.widgets.filter((w) => w.type === 'decision')).toHaveLength(3)
    expect(view.space_widgets.map((w) => w.data.title)).toEqual(['Launch readiness'])
    expect(db.state.reasons).toHaveLength(15)
    expect(db.state.reasons.filter((r) => r.author === 'user')).toHaveLength(2)
    expect(view.connections.length).toBeGreaterThanOrEqual(9)
    expect(Math.max(...view.connections.map((c) => c.reason_count))).toBeGreaterThan(1)
  })

  it('records the conversation: no tool call failed', async () => {
    const { db, space } = await seeded()
    const [user, reply] = db.messages(`space:${space.id}`)
    expect(user.role).toBe('user')
    const tools = reply.parts.filter((p) => p.type === 'tool')
    expect(tools.filter((p) => !p.ok)).toEqual([])
    expect(tools.length).toBeGreaterThan(40)
    const world = db.state.worlds.find((w) => w.title === 'Open decisions')!
    const worldChat = db.messages(`world:${world.id}`)
    expect(worldChat[0].from_space_agent).toBe(true)
    expect(worldChat[1].parts.filter((p) => p.type === 'tool')).toHaveLength(3)
  })

  it('the same script builds the empty space live', async () => {
    const { db, empty } = await seeded()
    const scope = { kind: 'space' as const, id: empty.id }
    expect(suggestionsFor(db, scope, SCRIPTS).map((s) => s.id)).toEqual(['petstore'])
    await answer(db, scope, SCRIPTS[0].label, SCRIPTS, {}, instantPace, () => {})
    expect(db.spaceView(empty.id).worlds).toHaveLength(6)
    expect(suggestionsFor(db, scope, SCRIPTS).map((s) => s.id)).toEqual(['link-checkout-store', 'update-tracker'])
  })
})

describe('scripts', () => {
  it('add the 404 once, then say it is there', async () => {
    const { db } = await seeded()
    const pets = db.state.worlds.find((w) => w.title === 'Pets endpoints')!
    const scope = { kind: 'world' as const, id: pets.id }
    const label = 'Add the 404 response to GET /pet/{petId}.'
    await answer(db, scope, label, SCRIPTS, {}, instantPace, () => {})
    const w = db.state.widgets.find((x) => x.world_id === pets.id && x.data.path === '/pet/{petId}')!
    expect((w.data.responses as unknown[]).length).toBe(3)
    const again = await answer(db, scope, label, SCRIPTS, {}, instantPace, () => {})
    expect(again.parts).toEqual([{ type: 'text', text: 'GET /pet/{petId} already documents a 404.' }])
  })

  it('find new links only once', async () => {
    const { db, space } = await seeded()
    const scope = { kind: 'space' as const, id: space.id }
    const label = SCRIPTS.find((s) => s.id === 'link-checkout-store')!.label
    await answer(db, scope, label, SCRIPTS, {}, instantPace, () => {})
    expect(db.state.reasons).toHaveLength(17)
    await answer(db, scope, label, SCRIPTS, {}, instantPace, () => {})
    expect(db.state.reasons).toHaveLength(17)
  })

  it('update the tracker from the worlds', async () => {
    const { db, space } = await seeded()
    const edge = db.state.widgets.find((w) => w.data.title === 'Edge cases to design')!
    db.updateWidget(edge.id, {
      data: { items: (edge.data.items as { text: string }[]).map((i) => ({ ...i, done: true })) },
    })
    const label = SCRIPTS.find((s) => s.id === 'update-tracker')!.label
    await answer(db, { kind: 'space', id: space.id }, label, SCRIPTS, {}, instantPace, () => {})
    const tracker = db.spaceView(space.id).space_widgets[0]
    const row = (tracker.data.items as { item: string; status: string }[]).find((r) => r.item.startsWith('Checkout'))
    expect(row?.status).toBe('Ready')
  })

  it('give the canned reply for free text', async () => {
    const { db, space } = await seeded()
    const msg = await answer(db, { kind: 'space', id: space.id }, 'hello?', SCRIPTS, {}, instantPace, () => {})
    expect(msg.parts[0].type === 'text' && msg.parts[0].text).toContain('prototype')
    expect(findScript(db, { kind: 'space', id: space.id }, 'PETSTORE', SCRIPTS)).toBeNull() // only offered when empty
  })

  it('stop keeps what was said and done so far', async () => {
    const db = new Db(undefined, () => 1)
    const space = db.createSpace('S')
    const script: Script = {
      id: 't',
      scope: 'space',
      label: 'go',
      when: () => true,
      steps: [
        { call: { tool: 'create_world', args: { title: 'One' } } },
        { say: 'next' },
        { call: { tool: 'create_world', args: { title: 'Two' } } },
      ],
    }
    const ctrl = new AbortController()
    const msg = await answer(
      db,
      { kind: 'space', id: space.id },
      'go',
      [script],
      { signal: ctrl.signal, onTool: () => ctrl.abort() },
      instantPace,
      () => {},
    )
    expect(msg.stopped).toBe(true)
    expect(db.state.worlds.map((w) => w.title)).toEqual(['One'])
  })
})

describe('tools', () => {
  it('validate every call and keep world agents in their world', async () => {
    const { db, space } = await seeded()
    const [w1, w2] = db.state.worlds.filter((w) => w.space_id === space.id)
    const scope = { kind: 'world' as const, id: w1.id }
    expect(runTool(db, scope, { tool: 'create_widget', args: { world_id: w2.id, type: 'note', data: { title: 'x' } } }).ok).toBe(false)
    expect(runTool(db, scope, { tool: 'create_world', args: { title: 'x' } }).ok).toBe(false)
    expect(runTool(db, scope, { tool: 'create_widget', args: { type: 'note', data: { title: '' } } })).toMatchObject({
      ok: false,
      summary: 'create_widget rejected: title: required',
    })
    expect(runTool(db, { kind: 'space', id: space.id }, { tool: 'add_reason', args: { widget_a: 1, widget_b: 99999, kind: 'k', text: 't' } }).ok).toBe(false)
    expect(runTool(db, scope, { tool: 'create_widget', args: { type: 'note', data: { title: 'ok' } } }).ok).toBe(true)
  })
})
