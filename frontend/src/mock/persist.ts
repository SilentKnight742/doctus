/*
 * The prototype keeps its database in localStorage. A schema version sits
 * beside it: when SCHEMA_VERSION changes (the shapes or the seed changed),
 * the saved data is dropped and the seed is loaded again. Every storage
 * access is guarded; without storage the data simply lives in memory.
 */
import type { DbState } from './db'

export const SCHEMA_VERSION = 'p0-3'
export const DATA_KEY = 'doctus.proto.db'
export const VERSION_KEY = 'doctus.proto.version'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function browserStorage(): Store | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function looksLikeState(v: unknown): v is DbState {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    typeof s.next_id === 'number' &&
    ['spaces', 'worlds', 'widgets', 'reasons', 'types'].every((k) => Array.isArray(s[k])) &&
    !!s.messages &&
    typeof s.messages === 'object'
  )
}

/** The saved state, or null when there is none, it is unreadable or its version is old. */
export function loadState(storage: Store | null = browserStorage()): DbState | null {
  try {
    if (!storage || storage.getItem(VERSION_KEY) !== SCHEMA_VERSION) return null
    const raw = storage.getItem(DATA_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return looksLikeState(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveState(state: DbState, storage: Store | null = browserStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(DATA_KEY, JSON.stringify(state))
    storage.setItem(VERSION_KEY, SCHEMA_VERSION)
    return true
  } catch {
    return false
  }
}

export function clearState(storage: Store | null = browserStorage()) {
  try {
    storage?.removeItem(DATA_KEY)
    storage?.removeItem(VERSION_KEY)
  } catch {
    // nothing saved, nothing to clear
  }
}
