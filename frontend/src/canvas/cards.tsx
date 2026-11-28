import { useQueryClient } from '@tanstack/react-query'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { api, describeError } from '../api/client'
import type { CanvasNode, Suggestion } from '../api/types'
import { Markdown } from '../chat/Markdown'
import { canvasKey, useStreams } from '../state/streams-context'
import { ConceptChips } from './ConceptChips'
import { nodeLabel } from './labels'
import { useCanvasCtx } from './context'
import type { Side } from './layout'

export type CardData = {
  node: CanvasNode
  side: Side
  fresh: boolean
  suggestions: Suggestion[]
}
export type CardNode = Node<CardData>

/** Connector handles on both sides; which pair an edge uses depends on the side. */
function Handles() {
  return (
    <>
      <Handle id="l-in" type="target" position={Position.Left} className="card-handle" isConnectable={false} />
      <Handle id="l-out" type="source" position={Position.Left} className="card-handle" isConnectable={false} />
      <Handle id="r-in" type="target" position={Position.Right} className="card-handle" isConnectable={false} />
      <Handle id="r-out" type="source" position={Position.Right} className="card-handle" isConnectable={false} />
    </>
  )
}

function cardClass(kind: string, node: CanvasNode, selected: boolean, fresh: boolean) {
  return [
    'card-node',
    `card-${kind}`,
    node.is_root && 'is-root',
    selected && 'is-selected',
    fresh && 'is-fresh',
  ]
    .filter(Boolean)
    .join(' ')
}

export function ChatCard({ data, selected }: NodeProps<CardNode>) {
  const { node, fresh, suggestions } = data
  const { subjectId, canvas, open, select, reveal } = useCanvasCtx()
  const streams = useStreams()
  const qc = useQueryClient()
  const live = streams.live.get(node.id)
  const [draft, setDraft] = useState('')
  const [asBranch, setAsBranch] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)
  const body = useRef<HTMLDivElement>(null)

  const streaming = Boolean(live?.running || node.streaming)
  const waiting = node.pending && !streaming
  const extractFailed = node.extract_pending && canvas.cartographer === 'error' && !streaming
  const retrying = streams.extracting.has(node.id)
  const [first, ...rest] = node.messages
  const prompt = first?.role === 'user' ? first.content : ''
  const thread = first?.role === 'user' ? rest : node.messages
  const lastSaved = node.messages[node.messages.length - 1]
  const liveQuestion =
    live?.running && live.question && !(lastSaved?.role === 'user' && lastSaved.content === live.question)
      ? live.question
      : null
  const error = live?.error ?? actionError

  // Follow the reply as it is written.
  useEffect(() => {
    if (streaming && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [streaming, live?.text])

  const titles = (id: number) => nodeLabel(canvas.nodes.find((n) => n.id === id))

  async function branchFrom(create: () => Promise<CanvasNode>) {
    setActionError(null)
    setCreating(true)
    try {
      const child = await create()
      await qc.invalidateQueries({ queryKey: canvasKey(subjectId) })
      reveal(child.id)
      void streams.ask(subjectId, child.id, null)
    } catch (err) {
      setActionError(err)
    } finally {
      setCreating(false)
    }
  }

  function send() {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    if (asBranch) {
      setAsBranch(false)
      void branchFrom(() => api.addChild(node.id, 'chat', text))
    } else {
      setActionError(null)
      void streams.ask(subjectId, node.id, text)
    }
  }

  const canFollowUp = !streaming && !waiting && !creating

  return (
    <div className="card-wrap">
      <div className={cardClass('chat', node, selected, fresh)}>
        <Handles />
        <header className="card-head">
          <span className="card-eyebrow">
            {node.is_root && <span className="origin-badge">Origin</span>}
            {node.title && <span className="card-title">{node.title}</span>}
          </span>
          <button
            type="button"
            className="card-open"
            onClick={(e) => {
              e.stopPropagation()
              open(node.id)
            }}
            title="Show the full conversation"
          >
            Open
          </button>
        </header>
        {prompt && <p className="card-prompt">{prompt}</p>}

        {(thread.length > 0 || streaming || liveQuestion) && (
          <div className="card-body nowheel nodrag" ref={body}>
            {thread.map((m) =>
              m.role === 'user' ? (
                <p key={m.id} className="card-followup">
                  {m.content}
                </p>
              ) : (
                <div key={m.id} className="card-answer">
                  <Markdown text={m.content} />
                  {m.stopped && <p className="card-meta">Stopped</p>}
                </div>
              ),
            )}
            {liveQuestion && <p className="card-followup">{liveQuestion}</p>}
            {live?.running &&
              (live.text ? (
                <div className="card-answer">
                  <Markdown text={live.text} />
                </div>
              ) : (
                <div className="typing" aria-label="The tutor is writing">
                  <span />
                  <span />
                  <span />
                </div>
              ))}
          </div>
        )}

        {waiting && !error && (
          <div className="card-state">
            <span className="muted">Not answered yet</span>
            <button
              type="button"
              className="button small-button primary nodrag"
              onClick={() => void streams.ask(subjectId, node.id, null)}
            >
              Answer
            </button>
          </div>
        )}

        {error != null && !streaming && (
          <div className="card-error nodrag" role="alert">
            <span>{describeError(error)}</span>
            {waiting && (
              <button
                type="button"
                className="button small-button"
                onClick={() => {
                  setActionError(null)
                  void streams.ask(subjectId, node.id, null)
                }}
              >
                Answer
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss"
              onClick={() => {
                setActionError(null)
                streams.dismissError(node.id)
              }}
            >
              ×
            </button>
          </div>
        )}

        {extractFailed && (
          <div className="card-state card-extract-failed nodrag" title={canvas.error ?? undefined}>
            <span className="warn-marker" aria-hidden="true">
              !
            </span>
            <span className="muted">Concepts not extracted</span>
            <button
              type="button"
              className="button small-button"
              disabled={retrying}
              onClick={() => void streams.retryExtract(subjectId, node.id)}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}

        <ConceptChips chips={node.concepts} titleOf={titles} onGoHome={select} />

        {streaming ? (
          <div className="card-state nodrag">
            <span className="muted">{live?.stopping ? 'Stopping…' : 'Writing…'}</span>
            <button
              type="button"
              className="button small-button"
              disabled={live?.stopping}
              onClick={() => void streams.stop(node.id)}
              title="Stop (Ctrl+Esc)"
            >
              Stop
            </button>
          </div>
        ) : (
          node.answered && (
            <form
              className="card-composer nodrag"
              onSubmit={(e) => {
                e.preventDefault()
                send()
              }}
            >
              <textarea
                rows={1}
                value={draft}
                disabled={!canFollowUp}
                placeholder={asBranch ? 'Ask in a new branch…' : 'Follow up…'}
                aria-label={asBranch ? 'Question for a new branch' : 'Follow-up question'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  } else if (e.key === 'Escape') {
                    e.currentTarget.blur()
                  }
                }}
              />
              <button
                type="button"
                className="branch-toggle"
                aria-pressed={asBranch}
                title="Ask in a new branch instead of here"
                onClick={() => setAsBranch((v) => !v)}
              >
                ↳ Branch
              </button>
              <button type="submit" className="button small-button primary" disabled={!canFollowUp || !draft.trim()}>
                Send
              </button>
            </form>
          )
        )}
      </div>

      {suggestions.length > 0 && !streaming && (
        <ul className="suggestions nodrag" aria-label="Suggested questions">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="suggestion"
                disabled={creating}
                onClick={(e) => {
                  e.stopPropagation()
                  void branchFrom(() => api.acceptSuggestion(s.id))
                }}
              >
                {s.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function NoteCard({ data, selected }: NodeProps<CardNode>) {
  const { node, fresh } = data
  return (
    <div className="card-wrap">
      <div className={cardClass('note', node, selected, fresh)}>
        <Handles />
        {node.title && (
          <header className="card-head">
            <span className="card-eyebrow">
              <span className="card-title">{node.title}</span>
            </span>
          </header>
        )}
        <div className="card-body nowheel nodrag">
          {node.note_body ? <Markdown text={node.note_body} /> : <p className="muted">Empty note</p>}
        </div>
      </div>
    </div>
  )
}
