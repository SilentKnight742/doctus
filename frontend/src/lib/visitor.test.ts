import { beforeEach, describe, expect, it } from 'vitest'
import { resetVisitorForTests, visitorToken } from './visitor'

describe('visitor token', () => {
  beforeEach(resetVisitorForTests)

  it('creates, stores and reuses a token', () => {
    const store = new Map<string, string>()
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const t = visitorToken(s)
    expect(t).toMatch(/^[0-9a-f]{32}$/)
    resetVisitorForTests()
    expect(visitorToken(s)).toBe(t)
  })

  it('falls back to memory when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const t = visitorToken(broken)
    expect(t.length).toBeGreaterThanOrEqual(16)
    expect(visitorToken(broken)).toBe(t)
  })
})
