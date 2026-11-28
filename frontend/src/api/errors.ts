/** Errors every API implementation throws (HTTP in N1, the mock in P0). */

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

/** The error for a failed fetch response (used by the HTTP client in N1). */
export { errorFromResponse }
