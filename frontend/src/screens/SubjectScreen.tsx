import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { api, describeError } from '../api/client'
import type { Subject } from '../api/types'
import { CanvasView } from '../canvas/CanvasView'
import { CanvasContext, type CanvasCtx } from '../canvas/context'
import { ConversationPanel } from '../canvas/ConversationPanel'
import { canvasKey } from '../state/streams-context'

/** One map: the canvas, its title and the side panel. */
export function SubjectScreen() {
  const subjectId = Number(useParams().subjectId)
  return <Subject key={subjectId} subjectId={subjectId} />
}

function Subject({ subjectId }: { subjectId: number }) {
  const canvas = useQuery({
    queryKey: canvasKey(subjectId),
    queryFn: () => api.canvas(subjectId),
    enabled: Number.isFinite(subjectId),
  })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [panelId, setPanelId] = useState<number | null>(null)
  const [focus, setFocus] = useState<{ id: number } | null>(null)
  const [reveal, setReveal] = useState<{ id: number } | null>(null)

  const title = canvas.data?.subject.title
  useEffect(() => {
    document.title = title ? `${title} · Doctus` : 'Doctus'
  }, [title])

  const select = useCallback((id: number) => {
    setSelectedId(id)
    setFocus({ id })
  }, [])
  const ctx: CanvasCtx | null = useMemo(
    () =>
      canvas.data
        ? {
            subjectId,
            canvas: canvas.data,
            open: (id: number) => {
              setPanelId(id)
              setSelectedId(id)
              setReveal({ id })
            },
            select,
            reveal: (id: number) => setReveal({ id }),
          }
        : null,
    [canvas.data, subjectId, select],
  )

  if (canvas.error) return <p className="error-banner page-pad">{describeError(canvas.error)}</p>
  if (!canvas.data || !ctx) return <p className="muted page-pad">Loading…</p>
  const panelNode = panelId !== null ? canvas.data.nodes.find((n) => n.id === panelId) : undefined

  return (
    <CanvasContext.Provider value={ctx}>
      <div className={`subject${panelNode ? ' has-panel' : ''}`}>
        <div className="subject-canvas">
          <MapTitle subject={canvas.data.subject} />
          <CartographerStatus state={canvas.data.cartographer} />
          <ReactFlowProvider>
            <CanvasView
              canvas={canvas.data}
              selectedId={selectedId}
              onSelect={setSelectedId}
              focus={focus}
              reveal={reveal}
            />
          </ReactFlowProvider>
        </div>
        {panelNode && (
          <ConversationPanel subjectId={subjectId} node={panelNode} onClose={() => setPanelId(null)} />
        )}
      </div>
    </CanvasContext.Provider>
  )
}

function CartographerStatus({ state }: { state: string }) {
  if (state !== 'running') return null
  return <p className="map-status muted">Mapping concepts…</p>
}

/** The map name; click to rename. */
function MapTitle({ subject }: { subject: Subject }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(subject.title)
  const rename = useMutation({
    mutationFn: (t: string) => api.renameSubject(subject.id, t),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['subjects'] })
      void qc.invalidateQueries({ queryKey: canvasKey(subject.id) })
    },
  })
  const save = () => {
    setEditing(false)
    const t = text.trim()
    if (t && t !== subject.title) rename.mutate(t)
    else setText(subject.title)
  }
  return (
    <div className="map-title">
      {editing ? (
        <input
          className="map-title-input"
          value={text}
          maxLength={120}
          autoFocus
          aria-label="Map name"
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              setText(subject.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="map-title-button"
          title="Rename map"
          onClick={() => {
            setText(subject.title)
            setEditing(true)
          }}
        >
          {rename.isPending ? text : subject.title}
        </button>
      )}
      {rename.error && <span className="map-title-error">{describeError(rename.error)}</span>}
    </div>
  )
}
