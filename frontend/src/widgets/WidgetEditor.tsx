import { useState } from 'react'
import { describeError } from '../api/client'
import type { FieldValue, Widget, WidgetData, WidgetType } from '../api/types'
import { FieldEditor, type FieldCtx } from './fields'
import { itemColumns } from './columns'

/** A form for any widget, built from its type's fields. Saves through the API (validated there). */
export function WidgetEditor({
  widget,
  type,
  ctx,
  onSave,
  onCancel,
}: {
  widget: Widget
  type: WidgetType
  ctx: FieldCtx
  onSave: (data: WidgetData) => Promise<unknown>
  onCancel: () => void
}) {
  const [data, setData] = useState<WidgetData>(() => structuredClone(widget.data))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (key: string, v: FieldValue) => setData((d) => ({ ...d, [key]: v }))
  const columns = itemColumns(type, data)

  return (
    <form
      className="widget-editor nodrag nowheel"
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        setError(null)
        try {
          await onSave(data)
        } catch (err) {
          setError(describeError(err))
        } finally {
          setSaving(false)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      {type.fields.map((f) => (
        <FieldEditor
          key={f.key}
          field={f}
          value={data[f.key] ?? null}
          onChange={(v) => set(f.key, v)}
          ctx={ctx}
          columns={f.key === type.view_options.items ? columns : undefined}
        />
      ))}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="button primary small-button" disabled={saving}>
          Save
        </button>
        <button type="button" className="button ghost small-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
