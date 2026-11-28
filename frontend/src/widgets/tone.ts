/** A colour tone for an enum value's badge (presentation only). */
export type Tone = 'info' | 'success' | 'warn' | 'danger' | 'muted' | 'neutral'

const TONES: Record<string, Tone> = {
  get: 'info',
  post: 'success',
  put: 'warn',
  patch: 'warn',
  delete: 'danger',
  open: 'warn',
  decided: 'success',
  parked: 'muted',
  ready: 'success',
  blocked: 'danger',
  'in progress': 'info',
  'not started': 'muted',
}

export function tone(value: string): Tone {
  return TONES[value.toLowerCase()] ?? 'neutral'
}
