import { visitorToken } from '../lib/visitor'
import { sseParser } from './sse'
import type {
  Canvas,
  CanvasNode,
  CanvasStatus,
  StreamDone,
  StreamStart,
  Subject,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 429: the model provider's rate limit. */
export class RateLimited extends ApiError {
  retryAfter: number | null
  constructor(message: string, retryAfter: number | null) {
    super(429, message)
    this.retryAfter = retryAfter
  }
}

/** 503: the model is overloaded for the moment. */
export class ModelBusy extends ApiError {
  retryAfter: number | null
  constructor(message: string, retryAfter: number | null) {
    super(503, message)
    this.retryAfter = retryAfter
  }
}

/** A short, human message for any error the client throws. */
export function describeError(err: unknown): string {
  if (err instanceof RateLimited) {
    const wait =
      err.retryAfter && err.retryAfter > 0 && err.retryAfter < 60
        ? `in ${err.retryAfter} s`
        : 'in a minute'
    return `Rate limited, try again ${wait}.`
  }
  if (err instanceof ModelBusy) return 'The model is busy, try again in a moment.'
  if (err instanceof ApiError) {
    if (err.status === 502) return `The model failed to answer: ${err.message}`
    return err.message
  }
  if (err instanceof DOMException && err.name === 'AbortError') return 'Stopped.'
  if (err instanceof TypeError) return 'Cannot reach the server.'
  return String(err)
}

/** The error a failed status maps to (also used for streamed `error` events). */
export function errorFor(status: number, message: string, retryAfter: number | null): ApiError {
  if (status === 429) return new RateLimited(message, retryAfter)
  if (status === 503) return new ModelBusy(message, retryAfter)
  return new ApiError(status, message)
}

function positive(n: unknown): number | null {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : null
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let detail = res.statusText || `HTTP ${res.status}`
  try {
    const data = await res.json()
    if (typeof data?.detail === 'string') detail = data.detail
    else if (Array.isArray(data?.detail))
      detail = data.detail.map((d: { msg?: string }) => d.msg).join('; ')
  } catch {
    // not JSON
  }
  return errorFor(res.status, detail, positive(res.headers.get('Retry-After')))
}

export interface StreamHandlers {
  onStart?: (start: StreamStart) => void
  onDelta?: (text: string) => void
  signal?: AbortSignal
}

/** How a streamed reply ended. A stopped or failed reply keeps what was written. */
export interface StreamResult {
  done: StreamDone | null
  /** Set when the reply failed after it began (the partial text is saved). */
  error: ApiError | null
  /** The saved reply's id (whole, stopped or partial), when anything was saved. */
  messageId: number | null
}

type Fetch = typeof fetch

export function makeClient(fetchImpl: Fetch = (...a) => fetch(...a), token = visitorToken) {
  function headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { 'X-Doctus-Visitor': token() }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.ok) return (await res.json()) as T
    throw await errorFromResponse(res)
  }

  /**
   * Ask the tutor in a chat node and stream the reply. Without `message`, it
   * answers the node's waiting question. Throws for a failure before the
   * reply begins (429/503/502...); a failure mid-reply comes back as
   * `result.error`. Aborting the signal drops the connection (the server
   * keeps what was written); prefer `stop()` for a clean stop.
   */
  async function chat(
    nodeId: number,
    message: string | null,
    { onStart, onDelta, signal }: StreamHandlers = {},
  ): Promise<StreamResult> {
    const res = await fetchImpl(`/api/canvas-nodes/${nodeId}/chat`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(message ? { message } : {}),
      signal,
    })
    if (!res.ok) throw await errorFromResponse(res)
    if (!res.body) throw new ApiError(502, 'The server sent no reply stream.')
    const parser = sseParser()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const result: StreamResult = { done: null, error: null, messageId: null }
    const handle = (events: ReturnType<typeof parser.push>) => {
      for (const { event, data } of events) {
        const d = data as Record<string, unknown>
        if (event === 'start') onStart?.(d as unknown as StreamStart)
        else if (event === 'delta') onDelta?.(String(d.text ?? ''))
        else if (event === 'done') {
          result.done = d as unknown as StreamDone
          result.messageId = result.done.message_id ?? null
        } else if (event === 'error') {
          result.messageId = typeof d.message_id === 'number' ? d.message_id : null
          result.error = errorFor(
            Number(d.status) || 502,
            String(d.message ?? 'The reply failed.'),
            positive(d.retry_after),
          )
        }
      }
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      handle(parser.push(decoder.decode(value, { stream: true })))
    }
    handle(parser.push(decoder.decode()))
    handle(parser.flush())
    return result
  }

  return {
    listSubjects: () => request<Subject[]>('GET', '/subjects'),
    createSubject: (title: string, firstQuestion: string) =>
      request<Subject>('POST', '/subjects', { title, first_question: firstQuestion }),
    renameSubject: (subjectId: number, title: string) =>
      request<Subject>('PATCH', `/subjects/${subjectId}`, { title }),
    canvas: (subjectId: number) => request<Canvas>('GET', `/subjects/${subjectId}/canvas`),
    status: (subjectId: number) =>
      request<CanvasStatus>('GET', `/subjects/${subjectId}/canvas/status`),
    addChild: (nodeId: number, kind: 'chat' | 'note', text: string) =>
      request<CanvasNode>('POST', `/canvas-nodes/${nodeId}/children`, { kind, text }),
    acceptSuggestion: (suggestionId: number) =>
      request<CanvasNode>('POST', `/suggestions/${suggestionId}/accept`),
    stop: (nodeId: number) => request<{ stopping: boolean }>('POST', `/canvas-nodes/${nodeId}/stop`),
    extract: (nodeId: number) => request<unknown>('POST', `/canvas-nodes/${nodeId}/extract`),
    chat,
  }
}

export const api = makeClient()
export type Api = ReturnType<typeof makeClient>
