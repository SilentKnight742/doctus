import { describe, expect, it } from 'vitest'
import { BUILTIN_TYPES, CHECKLIST, NOTE, OPENAPI_ENDPOINT } from './builtins'
import { decisionType, trackerType } from './custom'
import { ValidationError, emptyData, validateData, validateType, widgetTitle } from './validate'

function errors(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    if (e instanceof ValidationError) return e.errors
    throw e
  }
  return []
}

describe('validateData', () => {
  it('fills defaults for missing fields', () => {
    expect(validateData(NOTE, { title: 'Hello' })).toEqual({ title: 'Hello', body: '' })
  })

  it('rejects unknown fields, wrong types and missing required values', () => {
    expect(errors(() => validateData(NOTE, { title: '', colour: 'red' }))).toEqual([
      'colour: unknown field',
      'title: required',
    ])
    expect(errors(() => validateData(NOTE, { title: 3 }))).toContain('title: must be text')
    expect(errors(() => validateData(NOTE, null))).toEqual(['data: must be an object'])
    expect(errors(() => validateData(NOTE, []))).toEqual(['data: must be an object'])
  })

  it('checks enums, rows and their fields', () => {
    const bad = {
      method: 'FETCH',
      path: '/pet',
      parameters: [{ name: 'id', in: 'body', type: 'int', required: 'yes' }, 'nope'],
    }
    expect(errors(() => validateData(OPENAPI_ENDPOINT, bad))).toEqual([
      'method: must be one of GET, POST, PUT, PATCH, DELETE',
      'parameters[0].in: must be one of path, query, header, cookie',
      'parameters[0].required: must be true or false',
      'parameters[1]: must be a row',
    ])
  })

  it('fills missing row fields with defaults', () => {
    const d = validateData(CHECKLIST, { title: 'T', items: [{ text: 'a' }] })
    expect(d.items).toEqual([{ done: false, text: 'a' }])
  })

  it('checks dates, numbers, urls and files', () => {
    const t = decisionType(1)
    expect(errors(() => validateData(t, { question: 'Q', due: '12/12/2026' }))).toEqual([
      'due: must be a date (YYYY-MM-DD)',
    ])
    expect(errors(() => validateData(t, { question: 'Q', due: '2026-13-45' }))).toHaveLength(1)
    expect(validateData(t, { question: 'Q', due: '' }).due).toBe('')
    const link = BUILTIN_TYPES.find((x) => x.name === 'link')!
    expect(errors(() => validateData(link, { title: 'L', url: 'javascript:alert(1)' }))).toEqual([
      'url: must be an http(s) URL',
    ])
    const image = BUILTIN_TYPES.find((x) => x.name === 'image')!
    expect(errors(() => validateData(image, { title: 'I', image: { name: 'x' } }))).toEqual(['image: must be a file'])
  })

  it('checks references with the given checker', () => {
    const t = trackerType(1)
    const row = { item: 'a', world: { kind: 'world', id: 9 }, owner: '', status: 'Ready', due: '' }
    expect(errors(() => validateData(t, { title: 'T', items: [row] }, () => false))).toEqual([
      'items[0].world: points to a world that does not exist',
    ])
    expect(errors(() => validateData(t, { title: 'T', items: [{ ...row, world: { kind: 'widget', id: 9 } }] }))).toEqual(
      ['items[0].world: must point to a world'],
    )
    expect(validateData(t, { title: 'T', items: [row] }, () => true).items).toHaveLength(1)
  })
})

describe('types', () => {
  it('every builtin and custom type is a valid definition', () => {
    for (const t of [...BUILTIN_TYPES, decisionType(1), trackerType(1)]) expect(validateType(t), t.name).toEqual([])
  })

  it('empty data of every type validates', () => {
    for (const t of [...BUILTIN_TYPES, decisionType(1), trackerType(1)]) {
      const d = emptyData(t)
      for (const f of t.fields) if (f.required) d[f.key] = f.type === 'url' ? 'https://example.test' : 'x'
      expect(() => validateData(t, d), t.name).not.toThrow()
    }
  })

  it('rejects broken definitions', () => {
    const t = { ...NOTE, name: 'Bad Name', fields: [...NOTE.fields, NOTE.fields[0], { key: 'e', label: 'E', type: 'enum' as const }] }
    expect(validateType(t)).toEqual(['name: lower_snake_case', 'title: duplicate field', 'e: enum needs options'])
  })

  it('names a widget by its title field', () => {
    expect(widgetTitle(OPENAPI_ENDPOINT, { method: 'GET', path: ' /pet ' })).toBe('GET /pet')
    expect(widgetTitle(NOTE, { title: '' })).toBe('Note')
  })
})
