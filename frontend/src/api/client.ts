import { visitorToken } from '../lib/visitor'
import type { ChatReply, Graph, GraphStatus, NodeDetail, Subject } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class RateLimited extends ApiError {
  retryAfter: number | null
  constructor(message: string, retryAfter: number | null) {
    super(429, message)
    this.retryAfter = retryAfter
  }
}

/** A short, human message for any error the client throws. */
export function describeError(err: unknown): string {
  if (err instanceof RateLimited) {
    const wait =
      err.retryAfter && err.retryAfter > 0 && err.retryAfter < 120
        ? `in ${err.retryAfter} s`
        : 'in a minute'
    return `Rate limited, try again ${wait}.`
  }
  if (err instanceof ApiError) {
    if (err.status === 502) return `The model failed to answer: ${err.message}`
    return err.message
  }
  if (err instanceof TypeError) return 'Cannot reach the server.'
  return String(err)
}

type Fetch = typeof fetch

export function makeClient(fetchImpl: Fetch = (...a) => fetch(...a), token = visitorToken) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-Doctus-Visitor': token() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.ok) return (await res.json()) as T
    let detail = res.statusText || `HTTP ${res.status}`
    try {
      const data = await res.json()
      if (typeof data?.detail === 'string') detail = data.detail
      else if (Array.isArray(data?.detail)) detail = data.detail.map((d: { msg?: string }) => d.msg).join('; ')
    } catch {
      // not JSON
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('Retry-After'))
      throw new RateLimited(detail, Number.isFinite(ra) && ra > 0 ? ra : null)
    }
    throw new ApiError(res.status, detail)
  }

  return {
    listSubjects: () => request<Subject[]>('GET', '/subjects'),
    createSubject: (title: string, goal: string) =>
      request<Subject>('POST', '/subjects', { title, goal }),
    graph: (subjectId: number) => request<Graph>('GET', `/subjects/${subjectId}/graph`),
    status: (subjectId: number) => request<GraphStatus>('GET', `/subjects/${subjectId}/graph/status`),
    node: (nodeId: number) => request<NodeDetail>('GET', `/nodes/${nodeId}`),
    chat: (nodeId: number, message: string, fromNodeId: number | null) =>
      request<ChatReply>('POST', `/nodes/${nodeId}/chat`, {
        message,
        ...(fromNodeId ? { from_node_id: fromNodeId } : {}),
      }),
  }
}

export const api = makeClient()
export type Api = ReturnType<typeof makeClient>
