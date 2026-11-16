import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, describeError } from '../api/client'

export function Home() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: api.listSubjects })
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const create = useMutation({
    mutationFn: () => api.createSubject(title.trim(), goal.trim()),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['subjects'] })
      nav(`/s/${s.id}/chat/${s.origin_node_id}`)
    },
  })

  return (
    <div className="home page-pad">
      <section className="card">
        <h2>Start a subject</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim()) create.mutate()
          }}
        >
          <label className="field">
            <span>Subject</span>
            <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="German for travel" />
          </label>
          <label className="field">
            <span>Goal (optional)</span>
            <textarea value={goal} maxLength={1000} rows={2} onChange={(e) => setGoal(e.target.value)} placeholder="Order food and ask for directions" />
          </label>
          <div>
            <button className="button primary" disabled={!title.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Start'}
            </button>
          </div>
          {create.error && <p className="error-banner">{describeError(create.error)}</p>}
        </form>
      </section>
      {(subjects.data?.length ?? 0) > 0 && (
        <section>
          <h2>Your subjects</h2>
          <ul className="subject-list">
            {subjects.data!.map((s) => (
              <li key={s.id}>
                <Link to={`/s/${s.id}`} className="subject-row">
                  <span className="subject-title">{s.title}</span>
                  {s.goal && <span className="muted small">{s.goal}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {subjects.error && <p className="error-banner">{describeError(subjects.error)}</p>}
    </div>
  )
}
