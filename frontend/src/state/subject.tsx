import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { ContextUsed, GraphStatus } from '../api/types'
import { layout, type Point } from '../graph/layout'
import { pollInterval } from '../lib/poll'
import { Ctx, type SubjectState } from './context'

// Kept across remounts so switching screens does not re-layout.
const savedPositions = new Map<number, Map<number, Point>>()
const savedArrivals = new Map<number, Map<number, number | null>>()
const savedContexts = new Map<number, ContextUsed>()
const savedDrafts = new Map<number, string>()

export function SubjectProvider({ subjectId, children }: { subjectId: number; children: ReactNode }) {
  const qc = useQueryClient()
  const graphQ = useQuery({ queryKey: ['graph', subjectId], queryFn: () => api.graph(subjectId) })

  const pollStart = useRef<number | null>(null)
  const statusQ = useQuery({
    queryKey: ['status', subjectId],
    queryFn: () => api.status(subjectId),
    refetchInterval: (q) => {
      if (q.state.data?.cartographer !== 'running') {
        pollStart.current = null
        return false
      }
      pollStart.current ??= Date.now()
      return pollInterval(Date.now() - pollStart.current)
    },
  })

  const graph = graphQ.data
  const status = statusQ.data

  // A newer graph_version (or the end of a run) means: refetch the graph
  // and any open node (its evidence or edges may have changed).
  useEffect(() => {
    if (!status || !graph) return
    if (status.graph_version !== graph.graph_version || status.cartographer !== graph.cartographer) {
      qc.invalidateQueries({ queryKey: ['graph', subjectId] })
      if (status.graph_version !== graph.graph_version) {
        qc.invalidateQueries({ queryKey: ['node'] })
      }
    }
  }, [status, graph, qc, subjectId])

  // New nodes get a short highlight.
  const prevIds = useRef<Set<number> | null>(null)
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (!graph) return
    const ids = new Set(graph.nodes.map((n) => n.id))
    const before = prevIds.current
    prevIds.current = ids
    if (!before) return
    const added = [...ids].filter((id) => !before.has(id))
    if (added.length === 0) return
    setFreshIds(new Set(added))
    const t = setTimeout(() => setFreshIds(new Set()), 2500)
    return () => clearTimeout(t)
  }, [graph])

  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const positions = useMemo(() => {
    void layoutEpoch
    if (!graph) return new Map<number, Point>()
    const prev = savedPositions.get(subjectId)
    const next = layout(
      graph.nodes.map((n) => n.id),
      graph.edges,
      graph.subject.origin_node_id,
      prev,
    )
    savedPositions.set(subjectId, next)
    return next
  }, [graph, subjectId, layoutEpoch])

  const tidy = useCallback(() => {
    savedPositions.delete(subjectId)
    setLayoutEpoch((e) => e + 1)
  }, [subjectId])

  const nodesById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])

  const noteStatus = useCallback(
    (s: GraphStatus) => {
      pollStart.current = null
      qc.setQueryData(['status', subjectId], s)
    },
    [qc, subjectId],
  )

  const arrivals = useMemo(() => {
    if (!savedArrivals.has(subjectId)) savedArrivals.set(subjectId, new Map())
    return savedArrivals.get(subjectId)!
  }, [subjectId])

  const [, bump] = useState(0)
  const value: SubjectState = {
    subjectId,
    graph,
    graphError: graphQ.error,
    status: status ?? (graph && { graph_version: graph.graph_version, cartographer: graph.cartographer, error: graph.error }),
    nodesById,
    positions,
    tidy,
    freshIds,
    noteStatus,
    arrivedFrom: (id) => arrivals.get(id) ?? null,
    openFrom: (id, from) => {
      if (from !== null && from !== id) arrivals.set(id, from)
    },
    contextFor: (id) => savedContexts.get(id),
    setContext: (id, ctx) => {
      savedContexts.set(id, ctx)
      bump((n) => n + 1)
    },
    draft: (id) => savedDrafts.get(id) ?? '',
    setDraft: (id, text) => {
      if (text) savedDrafts.set(id, text)
      else savedDrafts.delete(id)
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
