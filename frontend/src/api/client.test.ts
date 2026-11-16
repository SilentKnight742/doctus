import { describe, expect, it, vi } from 'vitest'
import { ApiError, describeError, makeClient, RateLimited } from './client'

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
}

describe('api client', () => {
  it('sends the visitor header and JSON body', async () => {
    const f = respond(200, { reply: 'hi' })
    const api = makeClient(f as unknown as typeof fetch, () => 'v'.repeat(16))
    await api.chat(7, 'hello', 3)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/nodes/7/chat')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Doctus-Visitor']).toBe('v'.repeat(16))
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hello', from_node_id: 3 })
  })

  it('omits from_node_id when there is none', async () => {
    const f = respond(200, {})
    await makeClient(f as unknown as typeof fetch, () => 'x'.repeat(16)).chat(1, 'm', null)
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ message: 'm' })
  })

  it('turns 429 into RateLimited with Retry-After', async () => {
    const f = respond(429, { detail: 'Rate limited by the model provider.' }, { 'Retry-After': '30' })
    const api = makeClient(f as unknown as typeof fetch, () => 'x'.repeat(16))
    const err = await api.graph(1).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimited)
    expect(err.retryAfter).toBe(30)
    expect(describeError(err)).toBe('Rate limited, try again in 30 s.')
  })

  it('says "in a minute" when Retry-After is missing', () => {
    expect(describeError(new RateLimited('x', null))).toBe('Rate limited, try again in a minute.')
  })

  it('keeps the server detail for other errors', async () => {
    const f = respond(404, { detail: 'Node 9 not found.' })
    const err = await makeClient(f as unknown as typeof fetch, () => 'x'.repeat(16))
      .node(9)
      .catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
    expect(describeError(err)).toBe('Node 9 not found.')
  })
})
