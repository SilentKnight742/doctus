/*
 * Renders any widget from its type: one renderer per view template, fields
 * drawn by the primitive components. Adding a widget type needs no code here.
 */
import { useState } from 'react'
import type { FieldDef, FieldValue, Row, Widget, WidgetData, WidgetType } from '../api/types'
import { widgetTitle } from '../schema/validate'
import { itemColumns } from './columns'
import { Badge, FieldDisplay, type FieldCtx } from './fields'
import { isEmptyValue } from './values'

interface Props {
  widget: Widget
  type: WidgetType
  ctx: FieldCtx
  /** checklist: tick an item (writes through the API). */
  onPatch?: (data: WidgetData) => void
}

function isMeta(f: FieldDef, v: FieldValue): boolean {
  if (['enum', 'date', 'number', 'bool', 'ref', 'url'].includes(f.type)) return true
  return f.type === 'text' && typeof v === 'string' && v.length <= 40 && !v.includes('\n')
}

/** The fields of a card body: the lead text, short values in one meta line, the rest as labelled blocks. */
function Fields({
  fields,
  data,
  ctx,
  skip,
  lead,
}: {
  fields: FieldDef[]
  data: WidgetData
  ctx: FieldCtx
  skip: Set<string>
  lead?: string
}) {
  const shown = fields.filter((f) => !skip.has(f.key) && !isEmptyValue(data[f.key]))
  const leadField = shown.find((f) => f.key === lead)
  const rest = shown.filter((f) => f !== leadField)
  const meta = rest.filter((f) => isMeta(f, data[f.key]))
  const blocks = rest.filter((f) => !meta.includes(f))
  return (
    <>
      {leadField && (
        <div className="widget-lead">
          <FieldDisplay field={leadField} value={data[leadField.key]} ctx={ctx} />
        </div>
      )}
      {meta.length > 0 && (
        <dl className="widget-meta">
          {meta.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>
                <FieldDisplay field={f} value={data[f.key]} ctx={ctx} inline />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {blocks.map((f) => (
        <section key={f.key} className="widget-block">
          <h5 className="widget-label">{f.label}</h5>
          <FieldDisplay field={f} value={data[f.key]} ctx={ctx} />
        </section>
      ))}
    </>
  )
}

export function WidgetHeading({ widget, type }: { widget: Widget; type: WidgetType }) {
  const o = type.view_options
  const badge = o.badge ? widget.data[o.badge] : null
  const titleOnly = o.title ? String(widget.data[o.title] ?? '') : ''
  return (
    <h4 className="widget-title">
      {typeof badge === 'string' && badge && <Badge value={badge} />}
      <span>{o.title_prefix && o.title_prefix === o.badge ? titleOnly || type.label : widgetTitle(type, widget.data)}</span>
    </h4>
  )
}

export function WidgetBody({ widget, type, ctx, onPatch }: Props) {
  const o = type.view_options
  const data = widget.data
  const skip = new Set([o.title, o.badge, o.items, o.columns].filter((k): k is string => !!k))
  const itemsField = o.items ? type.fields.find((f) => f.key === o.items) : undefined
  const rows = (itemsField ? (data[itemsField.key] as Row[]) : []) ?? []

  switch (type.view) {
    case 'card':
      return (
        <div className="widget-body">
          <Fields fields={type.fields} data={data} ctx={ctx} lead={o.lead} skip={skip} />
        </div>
      )
    case 'table': {
      const p = o.progress
      const done = p ? rows.filter((r) => r[p.by] === p.done).length : 0
      return (
        <div className="widget-body">
          {p && rows.length > 0 && (
            <div className="progress" aria-label={`${done} of ${rows.length} ${p.done}`}>
              <div className="progress-bar">
                <span style={{ width: `${(done / rows.length) * 100}%` }} />
              </div>
              <span className="small muted">
                {done}/{rows.length} {p.done.toLowerCase()}
              </span>
            </div>
          )}
          {itemsField && <FieldDisplay field={{ ...itemsField, type: 'table' }} value={rows} ctx={ctx} columns={itemColumns(type, data)} />}
          <Fields fields={type.fields} data={data} ctx={ctx} lead={o.lead} skip={skip} />
        </div>
      )
    }
    case 'list':
      return (
        <div className="widget-body">
          {itemsField && <FieldDisplay field={{ ...itemsField, type: 'list' }} value={rows} ctx={ctx} />}
          <Fields fields={type.fields} data={data} ctx={ctx} lead={o.lead} skip={skip} />
        </div>
      )
    case 'checklist': {
      const check = o.check ?? 'done'
      const textKey = itemsField?.fields?.find((f) => f.key !== check)?.key
      return (
        <div className="widget-body">
          {/* Keyed by the saved rows: a tick shows at once, then the saved data takes over. */}
          <Checklist
            key={JSON.stringify(rows)}
            rows={rows}
            check={check}
            textKey={textKey}
            onChange={itemsField && onPatch ? (next) => onPatch({ [itemsField.key]: next }) : undefined}
          />
          <Fields fields={type.fields} data={data} ctx={ctx} lead={o.lead} skip={skip} />
        </div>
      )
    }
    case 'embed': {
      const urlField = type.fields.find((f) => f.type === 'url')
      const url = urlField ? String(data[urlField.key] ?? '') : ''
      let host = ''
      try {
        host = new URL(url).host
      } catch {
        host = url
      }
      return (
        <div className="widget-body">
          {url && (
            <a className="embed nodrag" href={url} target="_blank" rel="noreferrer">
              <span className="embed-host">{host}</span>
              <span className="embed-open">Open ↗</span>
            </a>
          )}
          <Fields fields={type.fields} data={data} ctx={ctx} lead={o.lead} skip={new Set([...skip, urlField?.key ?? ''])} />
        </div>
      )
    }
    case 'image': {
      const fileField = type.fields.find((f) => f.type === 'file')
      return (
        <div className="widget-body widget-body-image">
          {fileField && (data[fileField.key] ? <FieldDisplay field={fileField} value={data[fileField.key]} ctx={ctx} /> : <div className="image-empty muted small">No image yet</div>)}
          <Fields fields={type.fields} data={data} ctx={ctx} lead={o.lead} skip={new Set([...skip, fileField?.key ?? ''])} />
        </div>
      )
    }
  }
}

function Checklist({
  rows,
  check,
  textKey,
  onChange,
}: {
  rows: Row[]
  check: string
  textKey?: string
  onChange?: (rows: Row[]) => void
}) {
  const [local, setLocal] = useState(rows)
  const done = local.filter((r) => r[check]).length
  return (
    <>
      <p className="small muted checklist-count">
        {done} of {local.length} done
      </p>
      <ul className="checklist">
        {local.map((r, i) => (
          <li key={i} className={r[check] ? 'is-done' : ''}>
            <label className="nodrag">
              <input
                type="checkbox"
                checked={!!r[check]}
                disabled={!onChange}
                onChange={(e) => {
                  const next = local.map((x, j) => (j === i ? { ...x, [check]: e.target.checked } : x))
                  setLocal(next)
                  onChange?.(next)
                }}
              />
              <span>{textKey ? String(r[textKey] ?? '') : ''}</span>
            </label>
          </li>
        ))}
      </ul>
    </>
  )
}
