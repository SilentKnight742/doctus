import { describe, expect, it, vi } from 'vitest'
import { ApiError, describeError, makeClient, ModelBusy, RateLimited } from './client'
import { sseParser } from './sse'

const TOKEN = () => 'v'.repeat(16)

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
}

function streamOf(pieces: string[]) {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p))
      c.close()
    },
  })
}

function sseResponse(pieces: string[]) {
  return vi.fn(
    async () =>
      new Response(streamOf(pieces), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  )
}

const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

describe('api client', () => {
  it('sends the visitor header and JSON body', async () => {
    const f = respond(201, { id: 9 })
    await makeClient(f as unknown as typeof fetch, TOKEN).addChild(7, 'chat', 'Why?')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/canvas-nodes/7/children')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Doctus-Visitor']).toBe(TOKEN())
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'chat', text: 'Why?' })
  })

  it('creates a subject with its first question', async () => {
    const f = respond(201, { id: 1 })
    await makeClient(f as unknown as typeof fetch, TOKEN).createSubject('German', 'Cases?')
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ title: 'German', first_question: 'Cases?' })
  })

  it('turns 429 into RateLimited with Retry-After', async () => {
    const f = respond(429, { detail: 'rate limit' }, { 'Retry-After': '30' })
    const err = await makeClient(f as unknown as typeof fetch, TOKEN).canvas(1).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimited)
    expect(err.retryAfter).toBe(30)
    expect(describeError(err)).toBe('Rate limited, try again in 30 s.')
    expect(describeError(new RateLimited('x', null))).toBe('Rate limited, try again in a minute.')
  })

  it('turns 503 into ModelBusy', async () => {
    const f = respond(503, { detail: 'Gemini is busy' }, { 'Retry-After': '20' })
    const err = await makeClient(f as unknown as typeof fetch, TOKEN).extract(3).catch((e: ModelBusy) => e)
    if (!(err instanceof ModelBusy)) throw new Error('expected ModelBusy')
    expect(err).toBeInstanceOf(ModelBusy)
    expect(err.retryAfter).toBe(20)
    expect(describeError(err)).toBe('The model is busy, try again in a moment.')
  })

  it('keeps the detail of other errors', async () => {
    const f = respond(409, { detail: 'No reply is being written in this node.' })
    const err = await makeClient(f as unknown as typeof fetch, TOKEN).stop(3).catch((e: ApiError) => e)
    expect(err).toBeInstanceOf(ApiError)
    if (!(err instanceof ApiError)) throw new Error('expected ApiError')
    expect(err.status).toBe(409)
    expect(describeError(err)).toBe('No reply is being written in this node.')
    expect(describeError(new TypeError('fetch failed'))).toBe('Cannot reach the server.')
  })
})

describe('streamed chat', () => {
  it('reports start, deltas and done, even when pieces split events', async () => {
    const body =
      ev('start', { user_message_id: 4, context_used: { history_messages: 2 } }) +
      ev('delta', { text: 'Hal' }) +
      ev('delta', { text: 'lo' }) +
      ev('done', { message_id: 5, stopped: false, graph_version: 3, cartographer: 'running', error: null })
    const pieces = [body.slice(0, 17), body.slice(17, 60), body.slice(60, 61), body.slice(61)]
    const f = sseResponse(pieces)
    const deltas: string[] = []
    const onStart = vi.fn()
    const result = await makeClient(f as unknown as typeof fetch, TOKEN).chat(2, 'Hi', {
      onStart,
      onDelta: (t) => deltas.push(t),
    })
    expect(onStart).toHaveBeenCalledWith({ user_message_id: 4, context_used: { history_messages: 2 } })
    expect(deltas.join('')).toBe('Hallo')
    expect(result.messageId).toBe(5)
    expect(result.error).toBeNull()
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Hi' })
  })

  it('answers a waiting question with an empty body', async () => {
    const f = sseResponse([ev('done', { message_id: 1, stopped: false })])
    await makeClient(f as unknown as typeof fetch, TOKEN).chat(2, null)
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({})
  })

  it('returns a mid-reply failure as a typed error', async () => {
    const f = sseResponse([
      ev('delta', { text: 'Half' }),
      ev('error', { status: 503, message: 'busy', retry_after: 6, message_id: 9 }),
    ])
    const result = await makeClient(f as unknown as typeof fetch, TOKEN).chat(2, 'x')
    expect(result.error).toBeInstanceOf(ModelBusy)
    expect(result.done).toBeNull()
    expect(result.messageId).toBe(9)
  })

  it('throws a failure before the reply begins', async () => {
    const f = respond(429, { detail: 'rate' }, { 'Retry-After': '9' })
    const err = await makeClient(f as unknown as typeof fetch, TOKEN).chat(2, 'x').catch((e) => e)
    expect(err).toBeInstanceOf(RateLimited)
  })
})

describe('sse parser', () => {
  it('handles CRLF, multi-line data and a trailing event without a blank line', () => {
    const p = sseParser()
    expect(p.push('event: delta\r\ndata: {"text":')).toEqual([])
    expect(p.push('"a"}\r\n\r\nevent: done\ndata: {"x":1}')).toEqual([
      { event: 'delta', data: { text: 'a' } },
    ])
    expect(p.flush()).toEqual([{ event: 'done', data: { x: 1 } }])
  })
})
