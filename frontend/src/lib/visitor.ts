// The anonymous visitor token. Kept in localStorage; when storage is
// unavailable (private mode, blocked site data) it lives in memory for the
// lifetime of the page.
const KEY = 'doctus.visitor'
let memory: string | null = null

function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function visitorToken(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string {
  if (memory) return memory
  try {
    const saved = storage?.getItem(KEY)
    if (saved && saved.length >= 16) return (memory = saved)
  } catch {
    // fall through to a fresh token
  }
  memory = randomToken()
  try {
    storage?.setItem(KEY, memory)
  } catch {
    // memory only
  }
  return memory
}

export function resetVisitorForTests() {
  memory = null
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
