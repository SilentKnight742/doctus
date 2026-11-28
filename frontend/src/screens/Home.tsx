import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, describeError } from '../api/client'
import { DemoBadge } from '../shell/AppShell'

export function Home() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces })
  const [title, setTitle] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const create = useMutation({
    mutationFn: () => api.createSpace(title.trim() || 'Untitled space'),
    onSuccess: (s) => navigate(`/s/${s.id}`),
  })

  return (
    <div className="home">
      <div className="home-card">
        <div className="home-head">
          <span className="brand">Doctus</span>
          <DemoBadge />
        </div>
        <h1 className="home-title">Spaces</h1>
        <p className="muted">
          A space is one canvas of <strong>nodes</strong>. Each node holds widgets (endpoints, notes, screenshots,
          tables, decisions) and its own AI chat. Nodes connect through <strong>reasons</strong>: one widget here relates
          to one widget there, and why.
        </p>
        <ul className="space-list">
          {spaces.data?.map((s) => (
            <li key={s.id}>
              <Link to={`/s/${s.id}`} className="space-card">
                <span className="space-card-title">{s.title}</span>
                {s.description && <span className="muted small">{s.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
        <form
          className="new-space"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <input aria-label="New space title" placeholder="New space title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" className="button primary" disabled={create.isPending}>
            New empty space
          </button>
        </form>
        {create.error && <p className="form-error">{describeError(create.error)}</p>}
        <div className="home-note">
          <p className="muted small">
            Prototype: everything is stored in this browser, and the agents are scripted demos, not a model.
          </p>
          {confirmReset ? (
            <div className="inline-confirm reset-confirm">
              <span className="small">Drop your changes and reload the demo data?</span>
              <button
                type="button"
                className="link-button small danger"
                onClick={async () => {
                  setConfirmReset(false)
                  await api.resetDemo()
                  await qc.resetQueries()
                }}
              >
                Reset
              </button>
              <button type="button" className="link-button small" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="link-button small" onClick={() => setConfirmReset(true)}>
              Reset demo
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
