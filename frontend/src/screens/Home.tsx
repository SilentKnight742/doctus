import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, describeError } from '../api/client'

export function Home() {
  const navigate = useNavigate()
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces })
  const [title, setTitle] = useState('')
  const create = useMutation({
    mutationFn: () => api.createSpace(title.trim() || 'Untitled space'),
    onSuccess: (s) => navigate(`/s/${s.id}`),
  })

  return (
    <div className="home">
      <div className="home-card">
        <h1 className="home-title">Spaces</h1>
        <p className="muted">
          A space is one canvas of <strong>worlds</strong>. Each world holds widgets (endpoints, notes, screenshots,
          tables, decisions) and its own AI chat. Worlds connect through <strong>reasons</strong>: one widget here relates
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
        <p className="muted small home-note">
          Prototype: everything is stored in this browser, and the agents are scripted demos, not a model.
        </p>
      </div>
    </div>
  )
}
