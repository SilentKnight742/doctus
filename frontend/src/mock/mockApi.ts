/*
 * The prototype's API: the DoctusApi interface over the in-browser Db.
 * Every call is async with a small delay, returns copies (never live
 * objects), persists the change and notifies subscribers.
 */
import type { DoctusApi } from '../api/client'
import type { ChatScope } from '../api/types'
import { Db, type DbState } from './db'
import { answer, realPace, scopeKey, suggestionsFor, type Pace } from './agents/runner'
import { SCRIPTS } from './agents/petstore'
import { clearState, loadState, saveState } from './persist'
import { seedState } from './seed'

export interface MockOptions {
  latency?: number
  pace?: Pace
  load?: () => DbState | null
  save?: (s: DbState) => void
  clear?: () => void
}

export function makeMockApi(opts: MockOptions = {}): DoctusApi {
  const latency = opts.latency ?? 60
  const pace = opts.pace ?? realPace
  const load = opts.load ?? (() => loadState())
  const save = opts.save ?? ((s) => saveState(s))
  const clear = opts.clear ?? (() => clearState())
  const listeners = new Set<() => void>()
  const db = new Db()

  const ready = (async () => {
    const saved = load()
    db.state = saved ?? (await seedState())
    if (!saved) save(db.state)
  })()

  const changed = () => {
    save(db.state)
    for (const l of listeners) l()
  }
  const wait = () => (latency ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve())

  async function read<T>(fn: () => T): Promise<T> {
    await ready
    await wait()
    return structuredClone(fn())
  }
  async function write<T>(fn: () => T): Promise<T> {
    await ready
    await wait()
    const out = structuredClone(fn())
    changed()
    return out
  }

  return {
    kind: 'mock',
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    listSpaces: () => read(() => db.state.spaces),
    createSpace: (title, description) => write(() => db.createSpace(title, description)),
    updateSpace: (id, patch) => write(() => db.updateSpace(id, patch)),
    deleteSpace: (id) => write(() => db.deleteSpace(id)),
    getSpace: (id) => read(() => db.spaceView(id)),
    createWorld: (spaceId, input) => write(() => db.createWorld(spaceId, input)),
    updateWorld: (id, patch) => write(() => db.updateWorld(id, patch)),
    deleteWorld: (id) => write(() => db.deleteWorld(id)),
    getWorld: (id) => read(() => db.worldView(id)),
    createWidget: (input) => write(() => db.createWidget(input)),
    updateWidget: (id, patch) => write(() => db.updateWidget(id, patch)),
    deleteWidget: (id) => write(() => db.deleteWidget(id)),
    getConnection: (a, b) => read(() => db.connectionView(a, b)),
    createReason: (input) => write(() => db.createReason(input)),
    updateReason: (id, patch) => write(() => db.updateReason(id, patch)),
    deleteReason: (id) => write(() => db.deleteReason(id)),
    newWorldFromSelection: (input) => write(() => db.newWorldFromSelection(input)),
    messages: (scope: ChatScope) => read(() => db.messages(scopeKey(scope))),
    suggestions: (scope: ChatScope) => read(() => suggestionsFor(db, scope, SCRIPTS)),
    async chat(scope, text, events = {}) {
      await ready
      if (scope.kind === 'space') db.space(scope.id)
      else db.world(scope.id)
      return structuredClone(await answer(db, scope, text, SCRIPTS, events, pace, changed))
    },
    async resetDemo() {
      await ready
      clear()
      db.state = await seedState()
      changed()
    },
  }
}
