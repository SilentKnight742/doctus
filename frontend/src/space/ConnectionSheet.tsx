import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, describeError } from '../api/client'
import type { Id, ReasonDetail, WidgetRef } from '../api/types'
import { widgetTitle } from '../schema/validate'
import { REASON_KINDS } from './kinds'

function WidgetJump({ spaceId, w }: { spaceId: Id; w: WidgetRef }) {
  return (
    <Link className="widget-jump" to={`/s/${spaceId}/w/${w.world_id}?focus=${w.id}`} title={`Open in ${w.world_title}`}>
      <span className="widget-jump-title">{w.title}</span>
      <span className="widget-jump-world">{w.world_title}</span>
    </Link>
  )
}

function ReasonRow({
  spaceId,
  reason,
  selected,
  onToggle,
}: {
  spaceId: Id
  reason: ReasonDetail
  selected: boolean
  onToggle: (r: ReasonDetail) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [kind, setKind] = useState(reason.kind)
  const [text, setText] = useState(reason.text)
  const save = useMutation({ mutationFn: () => api.updateReason(reason.id, { kind, text }), onSuccess: () => setEditing(false) })
  const del = useMutation({ mutationFn: () => api.deleteReason(reason.id) })

  return (
    <tr className={selected ? 'is-selected' : ''}>
      <td>
        <input type="checkbox" aria-label="Select reason" checked={selected} onChange={() => onToggle(reason)} />
      </td>
      <td>
        {editing ? (
          <input list="reason-kinds" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} />
        ) : (
          <span className="reason-kind">{reason.kind}</span>
        )}
      </td>
      <td className="reason-text">
        {editing ? (
          <>
            <input aria-label="Reason" value={text} onChange={(e) => setText(e.target.value)} />
            {save.error && <p className="form-error">{describeError(save.error)}</p>}
          </>
        ) : (
          reason.text
        )}
      </td>
      <td>
        <span className="author" data-author={reason.author}>
          {reason.author === 'ai' ? 'AI' : 'User'}
        </span>
      </td>
      <td>
        <WidgetJump spaceId={spaceId} w={reason.a} />
      </td>
      <td>
        <WidgetJump spaceId={spaceId} w={reason.b} />
      </td>
      <td className="row-actions">
        {editing ? (
          <>
            <button type="button" className="link-button small" onClick={() => save.mutate()}>
              Save
            </button>
            <button type="button" className="link-button small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : confirm ? (
          <>
            <button type="button" className="link-button small danger" onClick={() => del.mutate()}>
              Delete
            </button>
            <button type="button" className="link-button small" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button type="button" className="link-button small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="link-button small" onClick={() => setConfirm(true)}>
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  )
}

function AddReason({ worldA, worldB }: { worldA: Id; worldB: Id }) {
  const a = useQuery({ queryKey: ['world', worldA], queryFn: () => api.getWorld(worldA) })
  const b = useQuery({ queryKey: ['world', worldB], queryFn: () => api.getWorld(worldB) })
  const [wa, setWa] = useState('')
  const [wb, setWb] = useState('')
  const [kind, setKind] = useState('depends on')
  const [text, setText] = useState('')
  const add = useMutation({
    mutationFn: () =>
      api.createReason({ widget_a: Number(wa), widget_b: Number(wb), kind, text, author: 'user' }),
    onSuccess: () => setText(''),
  })
  const options = (v: typeof a.data) =>
    v?.widgets.map((w) => (
      <option key={w.id} value={w.id}>
        {widgetTitle(
          v.widget_types.find((t) => t.name === w.type),
          w.data,
        )}
      </option>
    ))
  return (
    <form
      className="add-reason"
      onSubmit={(e) => {
        e.preventDefault()
        add.mutate()
      }}
    >
      <select aria-label={`Widget in ${a.data?.world.title ?? 'first world'}`} value={wa} onChange={(e) => setWa(e.target.value)}>
        <option value="">{a.data?.world.title ?? '…'}: widget</option>
        {options(a.data)}
      </select>
      <select aria-label={`Widget in ${b.data?.world.title ?? 'second world'}`} value={wb} onChange={(e) => setWb(e.target.value)}>
        <option value="">{b.data?.world.title ?? '…'}: widget</option>
        {options(b.data)}
      </select>
      <input list="reason-kinds" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} />
      <input aria-label="Why" placeholder="Why are they related?" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="button small-button" disabled={!wa || !wb || !text.trim() || add.isPending}>
        Add reason
      </button>
      {add.error && <p className="form-error">{describeError(add.error)}</p>}
    </form>
  )
}

/** The connection view: every reason between two worlds, editable, selectable. */
export function ConnectionSheet({
  spaceId,
  worldA,
  worldB,
  selected,
  onToggle,
  onClose,
}: {
  spaceId: Id
  worldA: Id
  worldB: Id
  selected: Map<Id, ReasonDetail>
  onToggle: (r: ReasonDetail) => void
  onClose: () => void
}) {
  const view = useQuery({ queryKey: ['connection', worldA, worldB], queryFn: () => api.getConnection(worldA, worldB) })
  const [adding, setAdding] = useState(false)
  const v = view.data
  const allSelected = !!v && v.reasons.every((r) => selected.has(r.id))

  return (
    <section className="sheet" aria-label="Connection">
      <datalist id="reason-kinds">
        {REASON_KINDS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <header className="sheet-head">
        <h2 className="sheet-title">
          {v ? (
            <>
              <Link to={`/s/${spaceId}/w/${v.worlds[0].id}`}>{v.worlds[0].title}</Link>
              <span className="muted"> ↔ </span>
              <Link to={`/s/${spaceId}/w/${v.worlds[1].id}`}>{v.worlds[1].title}</Link>
              <span className="muted small">
                {' '}
                · {v.reasons.length} reason{v.reasons.length === 1 ? '' : 's'}
              </span>
            </>
          ) : view.error ? (
            'This connection is gone'
          ) : (
            'Loading…'
          )}
        </h2>
        <button type="button" className="button ghost small-button" onClick={() => setAdding((x) => !x)}>
          {adding ? 'Done adding' : '+ Reason'}
        </button>
        <button type="button" className="icon-button" aria-label="Close connection" onClick={onClose}>
          ×
        </button>
      </header>
      {view.error && (
        <p className="sheet-empty muted">
          {describeError(view.error)}. Its last reason was removed, so the line disappeared.
        </p>
      )}
      {adding && <AddReason worldA={worldA} worldB={worldB} />}
      {v && (
        <div className="sheet-body">
          <table className="reason-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all reasons here"
                    checked={allSelected}
                    onChange={() => v.reasons.forEach((r) => (allSelected || !selected.has(r.id)) && onToggle(r))}
                  />
                </th>
                <th>Kind</th>
                <th>Reason</th>
                <th>By</th>
                <th>Widget</th>
                <th>Widget</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {v.reasons.map((r) => (
                <ReasonRow key={r.id} spaceId={spaceId} reason={r} selected={selected.has(r.id)} onToggle={onToggle} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
