import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, describeError } from '../api/client'
import { useStreams } from '../state/streams-context'

/** Start a new map: a title and the first question (the root chat). */
export function Home() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const { ask } = useStreams()
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  useEffect(() => {
    document.title = 'Doctus'
  }, [])
  const create = useMutation({
    mutationFn: () => api.createSubject(title.trim(), question.trim()),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['subjects'] })
      void ask(s.id, s.root_canvas_node_id, null)
      nav(`/s/${s.id}`)
    },
  })
  const ready = title.trim() && question.trim()

  return (
    <div className="home">
      <section className="home-card">
        <h1 className="home-title">What do you want to learn?</h1>
        <p className="muted">
          Ask anything. Each question you follow becomes a branch on your map, and the concepts you were taught are
          collected as you go.
        </p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) create.mutate()
          }}
        >
          <label className="field">
            <span>Map name</span>
            <input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="German grammar"
            />
          </label>
          <label className="field">
            <span>First question</span>
            <textarea
              value={question}
              maxLength={8000}
              rows={3}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (ready) create.mutate()
                }
              }}
              placeholder="How do German cases work?"
            />
          </label>
          <div>
            <button className="button primary" disabled={!ready || create.isPending}>
              {create.isPending ? 'Starting…' : 'Start'}
            </button>
          </div>
          {create.error && <p className="error-banner">{describeError(create.error)}</p>}
        </form>
      </section>
    </div>
  )
}
