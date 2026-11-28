import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { SpaceView, Widget, WidgetType } from '../api/types'
import type { FieldCtx } from '../widgets/fields'
import { starterData } from '../widgets/starter'
import { WidgetBody, WidgetHeading } from '../widgets/WidgetView'
import { WidgetEditor } from '../widgets/WidgetEditor'

function SpaceWidget({ widget, type, ctx }: { widget: Widget; type: WidgetType; ctx: FieldCtx }) {
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const patch = useMutation({ mutationFn: (data: Widget['data']) => api.updateWidget(widget.id, { data }) })
  return (
    <article className="space-widget">
      <header className="widget-head">
        <WidgetHeading widget={widget} type={type} />
        {!editing && (
          <span className="widget-tools">
            <button type="button" className="icon-button small" aria-label="Edit" onClick={() => setEditing(true)}>
              ✎
            </button>
            <button type="button" className="icon-button small" aria-label="Delete" onClick={() => setConfirm(true)}>
              ×
            </button>
          </span>
        )}
      </header>
      {confirm && (
        <div className="inline-confirm">
          <span className="small">Delete this widget?</span>
          <button type="button" className="link-button small danger" onClick={() => api.deleteWidget(widget.id)}>
            Delete
          </button>
          <button type="button" className="link-button small" onClick={() => setConfirm(false)}>
            Keep
          </button>
        </div>
      )}
      {editing ? (
        <WidgetEditor
          widget={widget}
          type={type}
          ctx={ctx}
          onSave={async (data) => {
            await api.updateWidget(widget.id, { data })
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <WidgetBody widget={widget} type={type} ctx={ctx} onPatch={(d) => patch.mutate(d)} />
      )}
      <p className="small muted widget-type-line">
        {type.label}
        {!type.builtin && ' · space type'}
      </p>
    </article>
  )
}

/** Widgets that belong to the space itself (trackers), not to any node. */
export function SpaceWidgets({ view }: { view: SpaceView }) {
  const ctx: FieldCtx = { spaceId: view.space.id, worlds: view.worlds }
  const [adding, setAdding] = useState(false)
  const types = view.widget_types
  return (
    <div className="space-widgets">
      <p className="muted small">
        Space-level widgets track work across nodes. They use the same widget types; the tracker below is a type defined
        for this space, not built in.
      </p>
      {view.space_widgets.map((w) => {
        const t = types.find((x) => x.name === w.type)
        return t ? <SpaceWidget key={w.id} widget={w} type={t} ctx={ctx} /> : null
      })}
      {adding ? (
        <div className="type-menu">
          {types.map((t) => (
            <button
              key={t.name}
              type="button"
              className="type-menu-item"
              onClick={async () => {
                await api.createWidget({ space_id: view.space.id, world_id: null, type: t.name, data: starterData(t) })
                setAdding(false)
              }}
            >
              <span>{t.label}</span>
              <span className="muted small">{t.description}</span>
            </button>
          ))}
          <button type="button" className="link-button small" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="button small-button" onClick={() => setAdding(true)}>
          + Space widget
        </button>
      )}
    </div>
  )
}
