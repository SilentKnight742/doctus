/*
 * One display component and one editor per primitive field type. Every
 * widget renderer and editor is built from these, driven by the type's
 * schema; nothing here knows about specific widget types.
 */
import { useId } from 'react'
import { Link } from 'react-router'
import type { FieldDef, FieldValue, FileValue, RefValue, Row } from '../api/types'
import { Markdown } from '../chat/Markdown'
import { emptyRow } from '../schema/validate'
import { tone } from './tone'
import { isEmptyValue } from './values'

/** What a field needs from around it: links and pickers for refs. */
export interface FieldCtx {
  spaceId: number
  worlds: { id: number; title: string }[]
  /** Widgets that a widget ref may point to (with their world). */
  widgets?: { id: number; title: string; world_id: number | null }[]
}

function formatDate(s: string): string {
  const d = new Date(`${s}T00:00:00`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function Badge({ value }: { value: string }) {
  return (
    <span className="badge" data-tone={tone(value)}>
      {value}
    </span>
  )
}

function RefLink({ value, ctx }: { value: RefValue; ctx: FieldCtx }) {
  if (value.kind === 'world') {
    const w = ctx.worlds.find((x) => x.id === value.id)
    return (
      <Link className="ref-chip nodrag" to={`/s/${ctx.spaceId}/w/${value.id}`}>
        {w?.title ?? `Node ${value.id}`}
      </Link>
    )
  }
  const w = ctx.widgets?.find((x) => x.id === value.id)
  if (!w || w.world_id == null) return <span className="ref-chip">{w?.title ?? `Widget ${value.id}`}</span>
  return (
    <Link className="ref-chip nodrag" to={`/s/${ctx.spaceId}/w/${w.world_id}?focus=${w.id}`}>
      {w.title}
    </Link>
  )
}

export function FieldDisplay({
  field,
  value,
  ctx,
  inline = false,
  columns,
}: {
  field: FieldDef
  value: FieldValue
  ctx: FieldCtx
  /** In a table cell or a meta line: no block layout. */
  inline?: boolean
  /** list / table: header labels overriding the row fields' labels. */
  columns?: string[]
}) {
  switch (field.type) {
    case 'text':
      return inline ? <span className="cell-text">{String(value ?? '')}</span> : <Markdown text={String(value ?? '')} />
    case 'number':
      return <span>{typeof value === 'number' ? value.toLocaleString() : ''}</span>
    case 'date':
      return <span className="nowrap">{value ? formatDate(String(value)) : ''}</span>
    case 'bool':
      return <span aria-label={value ? 'yes' : 'no'}>{value ? '✓' : '–'}</span>
    case 'enum':
      return value ? <Badge value={String(value)} /> : null
    case 'url': {
      const url = String(value ?? '')
      return url ? (
        <a className="nodrag" href={url} target="_blank" rel="noreferrer">
          {url.replace(/^https?:\/\//, '')}
        </a>
      ) : null
    }
    case 'file': {
      const f = value as FileValue | null
      if (!f) return null
      return f.kind === 'image' ? (
        <img className="field-image" src={f.src} alt={f.name} draggable={false} />
      ) : (
        <a className="nodrag" href={f.src} target="_blank" rel="noreferrer">
          {f.name}
        </a>
      )
    }
    case 'ref':
      return value ? <RefLink value={value as RefValue} ctx={ctx} /> : null
    case 'code':
      return value ? (
        <pre className="field-code nowheel">
          <code>{String(value)}</code>
        </pre>
      ) : null
    case 'list':
    case 'table': {
      const rows = (value as Row[] | null) ?? []
      const subs = (field.fields ?? []).slice(0, columns ? columns.length : undefined)
      if (field.type === 'list')
        return (
          <ul className="field-list">
            {rows.map((r, i) => (
              <li key={i}>
                {subs.map((f) =>
                  isEmptyValue(r[f.key]) ? null : (
                    <span key={f.key} className="field-list-part">
                      <FieldDisplay field={f} value={r[f.key]} ctx={ctx} inline />
                    </span>
                  ),
                )}
              </li>
            ))}
          </ul>
        )
      return (
        <div className="field-table nowheel">
          <table>
            <thead>
              <tr>
                {subs.map((f, i) => (
                  <th key={f.key}>{columns?.[i] || f.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {subs.map((f) => (
                    <td key={f.key}>
                      <FieldDisplay field={f} value={r[f.key]} ctx={ctx} inline />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }
}

// ---------- editors ----------

export function FieldEditor({
  field,
  value,
  onChange,
  ctx,
  compact = false,
  columns,
}: {
  field: FieldDef
  value: FieldValue
  onChange: (v: FieldValue) => void
  ctx: FieldCtx
  compact?: boolean
  columns?: string[]
}) {
  const id = useId()
  const label = compact ? undefined : field.label
  const wrap = (control: React.ReactNode) =>
    compact ? (
      control
    ) : (
      <label className="field" htmlFor={id}>
        <span>
          {label}
          {field.required && <span aria-hidden> *</span>}
        </span>
        {control}
      </label>
    )

  switch (field.type) {
    case 'text': {
      const v = String(value ?? '')
      return wrap(
        compact ? (
          <input id={id} aria-label={field.label} value={v} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <textarea id={id} rows={Math.min(8, Math.max(2, v.split('\n').length + 1))} value={v} onChange={(e) => onChange(e.target.value)} />
        ),
      )
    }
    case 'code':
      return wrap(
        <textarea
          id={id}
          className="mono"
          rows={Math.min(10, Math.max(3, String(value ?? '').split('\n').length + 1))}
          value={String(value ?? '')}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />,
      )
    case 'number':
      return wrap(
        <input
          id={id}
          type="number"
          aria-label={field.label}
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />,
      )
    case 'date':
      return wrap(
        <input id={id} type="date" aria-label={field.label} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />,
      )
    case 'url':
      return wrap(
        <input id={id} type="url" aria-label={field.label} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />,
      )
    case 'bool':
      return compact ? (
        <input type="checkbox" aria-label={field.label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      ) : (
        <label className="field-check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {field.label}
        </label>
      )
    case 'enum':
      return wrap(
        <select id={id} aria-label={field.label} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>,
      )
    case 'ref': {
      const r = value as RefValue | null
      const kind = field.ref_kind ?? 'world'
      const options = kind === 'world' ? ctx.worlds : (ctx.widgets ?? [])
      return wrap(
        <select
          id={id}
          aria-label={field.label}
          value={r ? String(r.id) : ''}
          onChange={(e) => onChange(e.target.value ? { kind, id: Number(e.target.value) } : null)}
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>,
      )
    }
    case 'file':
      return wrap(<FileEditor id={id} value={value as FileValue | null} onChange={onChange} />)
    case 'list':
    case 'table':
      return <RowsEditor field={field} rows={(value as Row[] | null) ?? []} onChange={onChange} ctx={ctx} columns={columns} />
  }
}

function FileEditor({ id, value, onChange }: { id: string; value: FileValue | null; onChange: (v: FileValue | null) => void }) {
  return (
    <div className="file-editor">
      {value?.kind === 'image' && <img className="field-image small" src={value.src} alt="" />}
      <span className="muted small">{value ? value.name : 'No file'}</span>
      <input
        id={id}
        type="file"
        accept="image/*,application/pdf"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          // Prototype: kept inline as a data URL. N5 stores uploads on the server.
          const reader = new FileReader()
          reader.onload = () =>
            onChange({ name: file.name, src: String(reader.result), kind: file.type.startsWith('image/') ? 'image' : 'document' })
          reader.readAsDataURL(file)
        }}
      />
      {value && (
        <button type="button" className="link-button small" onClick={() => onChange(null)}>
          Remove
        </button>
      )}
    </div>
  )
}

function RowsEditor({
  field,
  rows,
  onChange,
  ctx,
  columns,
}: {
  field: FieldDef
  rows: Row[]
  onChange: (rows: Row[]) => void
  ctx: FieldCtx
  columns?: string[]
}) {
  const subs = (field.fields ?? []).slice(0, columns ? columns.length : undefined)
  const set = (i: number, key: string, v: FieldValue) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)))
  return (
    <fieldset className="rows-editor">
      <legend>{field.label}</legend>
      <div className="rows-grid nowheel" style={{ gridTemplateColumns: `repeat(${subs.length}, minmax(5rem, 1fr)) auto` }}>
        {subs.map((f, i) => (
          <span key={f.key} className="rows-head">
            {columns?.[i] || f.label}
          </span>
        ))}
        <span />
        {rows.map((r, i) => (
          <RowCells key={i} subs={subs} row={r} ctx={ctx} onSet={(k, v) => set(i, k, v)} onRemove={() => onChange(rows.filter((_, j) => j !== i))} />
        ))}
      </div>
      <button type="button" className="link-button small" onClick={() => onChange([...rows, emptyRow(field)])}>
        + Add row
      </button>
    </fieldset>
  )
}

function RowCells({
  subs,
  row,
  ctx,
  onSet,
  onRemove,
}: {
  subs: FieldDef[]
  row: Row
  ctx: FieldCtx
  onSet: (key: string, v: FieldValue) => void
  onRemove: () => void
}) {
  return (
    <>
      {subs.map((f) => (
        <FieldEditor key={f.key} field={f} value={row[f.key] ?? null} onChange={(v) => onSet(f.key, v)} ctx={ctx} compact />
      ))}
      <button type="button" className="icon-button small" aria-label="Remove row" onClick={onRemove}>
        ×
      </button>
    </>
  )
}
