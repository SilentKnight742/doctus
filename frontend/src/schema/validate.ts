/*
 * Widget data validation against a widget type's schema. Pure; the mock API
 * runs it on every write (N1 does the same server-side).
 */
import type { FieldDef, FieldValue, RefValue, Row, WidgetData, WidgetType } from '../api/types'

export interface RefChecker {
  (ref: RefValue): boolean
}

export class ValidationError extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(errors.join('; '))
    this.errors = errors
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function defaultFor(field: FieldDef): FieldValue {
  switch (field.type) {
    case 'text':
    case 'url':
    case 'code':
    case 'date':
      return ''
    case 'number':
      return 0
    case 'bool':
      return false
    case 'enum':
      return field.options?.[0] ?? ''
    case 'file':
    case 'ref':
      return null
    case 'list':
    case 'table':
      return []
  }
}

export function emptyData(type: WidgetType): WidgetData {
  return Object.fromEntries(type.fields.map((f) => [f.key, defaultFor(f)]))
}

export function emptyRow(field: FieldDef): Row {
  return Object.fromEntries((field.fields ?? []).map((f) => [f.key, defaultFor(f)]))
}

function isEmpty(field: FieldDef, v: FieldValue): boolean {
  if (v === null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  return field.type === 'number' ? false : false
}

function isUrl(s: string): boolean {
  if (s.startsWith('/')) return true // a bundled asset
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function checkValue(field: FieldDef, v: unknown, path: string, refOk: RefChecker | null, errors: string[]) {
  const fail = (msg: string) => errors.push(`${path}: ${msg}`)
  switch (field.type) {
    case 'text':
    case 'code':
      if (typeof v !== 'string') fail('must be text')
      return
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) fail('must be a number')
      return
    case 'date':
      if (typeof v !== 'string' || (v !== '' && (!DATE.test(v) || Number.isNaN(Date.parse(v)))))
        fail('must be a date (YYYY-MM-DD)')
      return
    case 'bool':
      if (typeof v !== 'boolean') fail('must be true or false')
      return
    case 'enum':
      if (typeof v !== 'string' || !(field.options ?? []).includes(v))
        fail(`must be one of ${(field.options ?? []).join(', ')}`)
      return
    case 'url':
      if (typeof v !== 'string' || (v !== '' && !isUrl(v))) fail('must be an http(s) URL')
      return
    case 'file': {
      if (v === null) return
      const f = v as Record<string, unknown>
      if (
        typeof f !== 'object' ||
        typeof f.name !== 'string' ||
        typeof f.src !== 'string' ||
        (f.kind !== 'image' && f.kind !== 'document')
      )
        fail('must be a file')
      return
    }
    case 'ref': {
      if (v === null) return
      const r = v as Record<string, unknown>
      if (typeof r !== 'object' || (r.kind !== 'widget' && r.kind !== 'world') || typeof r.id !== 'number') {
        fail('must be a reference')
        return
      }
      if (field.ref_kind && r.kind !== field.ref_kind) fail(`must point to a ${field.ref_kind}`)
      else if (refOk && !refOk(r as unknown as RefValue)) fail(`points to a ${r.kind} that does not exist`)
      return
    }
    case 'list':
    case 'table': {
      if (!Array.isArray(v)) {
        fail('must be a list of rows')
        return
      }
      v.forEach((row, i) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          errors.push(`${path}[${i}]: must be a row`)
          return
        }
        checkFields(field.fields ?? [], row as Record<string, unknown>, `${path}[${i}]`, refOk, errors)
      })
      return
    }
  }
}

function checkFields(
  fields: FieldDef[],
  data: Record<string, unknown>,
  prefix: string,
  refOk: RefChecker | null,
  errors: string[],
) {
  const known = new Set(fields.map((f) => f.key))
  for (const k of Object.keys(data)) if (!known.has(k)) errors.push(`${prefix ? `${prefix}.` : ''}${k}: unknown field`)
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.key}` : f.key
    if (!(f.key in data)) {
      errors.push(`${path}: missing`)
      continue
    }
    const v = data[f.key]
    checkValue(f, v, path, refOk, errors)
    if (f.required && isEmpty(f, v as FieldValue)) errors.push(`${path}: required`)
  }
}

/** Fill missing fields (and missing row fields) with their defaults. */
export function withDefaults(type: WidgetType, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data }
  for (const f of type.fields) {
    if (!(f.key in out)) out[f.key] = defaultFor(f)
    else if ((f.type === 'list' || f.type === 'table') && Array.isArray(out[f.key])) {
      out[f.key] = (out[f.key] as unknown[]).map((row) =>
        row && typeof row === 'object' && !Array.isArray(row) ? { ...emptyRow(f), ...row } : row,
      )
    }
  }
  return out
}

/**
 * Validate `data` against `type`. Missing fields take their defaults; unknown
 * fields, wrong types and dangling references are errors. Returns the full
 * data or throws a ValidationError listing every problem.
 */
export function validateData(type: WidgetType, data: unknown, refOk: RefChecker | null = null): WidgetData {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new ValidationError(['data: must be an object'])
  const full = withDefaults(type, data as Record<string, unknown>)
  const errors: string[] = []
  checkFields(type.fields, full, '', refOk, errors)
  if (errors.length) throw new ValidationError(errors)
  return full as WidgetData
}

/** Validate a type definition itself (used for non-builtin types). */
export function validateType(type: WidgetType): string[] {
  const errors: string[] = []
  const keys = new Set<string>()
  if (!/^[a-z][a-z0-9_]*$/.test(type.name)) errors.push('name: lower_snake_case')
  for (const f of type.fields) {
    if (keys.has(f.key)) errors.push(`${f.key}: duplicate field`)
    keys.add(f.key)
    if (f.type === 'enum' && !f.options?.length) errors.push(`${f.key}: enum needs options`)
    if ((f.type === 'list' || f.type === 'table') && !f.fields?.length) errors.push(`${f.key}: rows need fields`)
    for (const sub of f.fields ?? [])
      if (sub.type === 'list' || sub.type === 'table') errors.push(`${f.key}.${sub.key}: no nested rows`)
  }
  const o = type.view_options
  for (const k of [o.title, o.badge, o.items, o.lead, o.columns, o.title_prefix]) if (k && !keys.has(k)) errors.push(`view_options: no field ${k}`)
  return errors
}

/** The widget's display name: its title field, or the type's label. */
export function widgetTitle(type: WidgetType | undefined, data: WidgetData): string {
  const key = type?.view_options.title
  const v = key ? data[key] : null
  if (typeof v !== 'string' || !v.trim()) return type?.label ?? 'Widget'
  const pre = type?.view_options.title_prefix ? data[type.view_options.title_prefix] : null
  return typeof pre === 'string' && pre ? `${pre} ${v.trim()}` : v.trim()
}
