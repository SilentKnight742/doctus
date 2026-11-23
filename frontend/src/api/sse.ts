/** One server-sent event: its name and parsed JSON data. */
export interface SseEvent {
  event: string
  data: unknown
}

/**
 * Incremental parser for a server-sent-events body. Feed it decoded text as
 * it arrives (pieces may split anywhere); it returns the events completed so
 * far. Only `event:` and `data:` fields are used; data is JSON.
 */
export function sseParser() {
  let buffer = ''

  function parseBlock(block: string): SseEvent | null {
    let event = 'message'
    const data: string[] = []
    for (const raw of block.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!data.length) return null
    try {
      return { event, data: JSON.parse(data.join('\n')) }
    } catch {
      return { event, data: data.join('\n') }
    }
  }

  return {
    push(text: string): SseEvent[] {
      buffer += text.replace(/\r\n/g, '\n')
      const out: SseEvent[] = []
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const ev = parseBlock(buffer.slice(0, cut))
        if (ev) out.push(ev)
        buffer = buffer.slice(cut + 2)
        cut = buffer.indexOf('\n\n')
      }
      return out
    },
    /** Whatever is left when the stream ends (a last event without a blank line). */
    flush(): SseEvent[] {
      const rest = buffer.trim()
      buffer = ''
      const ev = rest ? parseBlock(rest) : null
      return ev ? [ev] : []
    },
  }
}
