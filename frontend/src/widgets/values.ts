import type { FieldValue } from '../api/types'

export function isEmptyValue(v: FieldValue): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0)
}
