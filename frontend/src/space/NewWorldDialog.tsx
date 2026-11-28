import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, describeError } from '../api/client'
import type { Id, ReasonDetail, World } from '../api/types'

/** "New world from selection": name it, copy (default) or move the referenced widgets. */
export function NewWorldDialog({
  spaceId,
  reasons,
  position,
  onDone,
  onCancel,
}: {
  spaceId: Id
  reasons: ReasonDetail[]
  position: { x: number; y: number }
  onDone: (world: World) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const widgets = [...new Map(reasons.flatMap((r) => [r.a, r.b]).map((w) => [w.id, w])).values()]
  const create = useMutation({
    mutationFn: () =>
      api.newWorldFromSelection({
        space_id: spaceId,
        reason_ids: reasons.map((r) => r.id),
        title: title.trim(),
        mode,
        ...position,
      }),
    onSuccess: onDone,
  })

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])

  return (
    <dialog ref={ref} className="dialog" onCancel={onCancel} aria-labelledby="nw-title">
      <form
        method="dialog"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <h2 id="nw-title">New node from selection</h2>
        <label className="field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sold-pet handling" />
        </label>
        <fieldset className="mode-choice">
          <legend className="small muted">The {widgets.length} widgets these reasons reference</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'copy'} onChange={() => setMode('copy')} />
            <span>
              <strong>Copy</strong> <span className="muted small">originals stay; copies remember where they came from</span>
            </span>
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'move'} onChange={() => setMode('move')} />
            <span>
              <strong>Move</strong> <span className="muted small">widgets leave their nodes, keeping their reasons</span>
            </span>
          </label>
        </fieldset>
        <ul className="nw-widgets">
          {widgets.map((w) => (
            <li key={w.id}>
              <span>{w.title}</span> <span className="muted small">{w.world_title}</span>
            </li>
          ))}
        </ul>
        {create.error && <p className="form-error">{describeError(create.error)}</p>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={!title.trim() || create.isPending}>
            Create node
          </button>
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}
