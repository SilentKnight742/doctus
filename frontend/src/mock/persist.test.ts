import { describe, expect, it } from 'vitest'
import { emptyState } from './db'
import { DATA_KEY, SCHEMA_VERSION, VERSION_KEY, clearState, loadState, saveState } from './persist'
import { makeMockApi } from './mockApi'

function memoryStore() {
  const m = new Map<string, string>()
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

const throwing = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('quota')
  },
  removeItem: () => {
    throw new Error('denied')
  },
}

describe('persist', () => {
  it('round-trips the state with its version', () => {
    const s = memoryStore()
    const state = { ...emptyState(), next_id: 7 }
    expect(saveState(state, s)).toBe(true)
    expect(s.map.get(VERSION_KEY)).toBe(SCHEMA_VERSION)
    expect(loadState(s)?.next_id).toBe(7)
  })

  it('drops data saved under another schema version', () => {
    const s = memoryStore()
    saveState(emptyState(), s)
    s.setItem(VERSION_KEY, 'p0-0')
    expect(loadState(s)).toBeNull()
  })

  it('drops unreadable or malformed data', () => {
    const s = memoryStore()
    s.setItem(VERSION_KEY, SCHEMA_VERSION)
    s.setItem(DATA_KEY, '{not json')
    expect(loadState(s)).toBeNull()
    s.setItem(DATA_KEY, JSON.stringify({ spaces: 'x' }))
    expect(loadState(s)).toBeNull()
  })

  it('survives storage that throws or is missing', () => {
    expect(loadState(throwing)).toBeNull()
    expect(saveState(emptyState(), throwing)).toBe(false)
    expect(() => clearState(throwing)).not.toThrow()
    expect(loadState(null)).toBeNull()
    expect(saveState(emptyState(), null)).toBe(false)
  })
})

describe('mock api', () => {
  it('seeds when nothing is saved, saves changes, notifies, and resets', async () => {
    const saves: number[] = []
    let cleared = 0
    const api = makeMockApi({ latency: 0, load: () => null, save: (s) => saves.push(s.next_id), clear: () => cleared++ })
    let notified = 0
    api.subscribe(() => notified++)
    const spaces = await api.listSpaces()
    expect(spaces).toHaveLength(2)
    expect(saves).toHaveLength(1)
    const created = await api.createSpace('Mine')
    expect(notified).toBe(1)
    expect(await api.listSpaces()).toHaveLength(3)
    // results are copies, not live objects
    created.title = 'changed'
    expect((await api.listSpaces())[2].title).toBe('Mine')
    await api.resetDemo()
    expect(cleared).toBe(1)
    expect(await api.listSpaces()).toHaveLength(2)
  })
})
