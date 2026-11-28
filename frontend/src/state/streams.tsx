import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { ContextUsed } from '../api/types'
import { pollInterval } from '../lib/poll'
import { canvasKey, Ctx, type LiveReply } from './streams-context'

export function StreamsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [live, setLive] = useState<Map<number, LiveReply>>(new Map())
  const [contexts, setContexts] = useState<Map<number, ContextUsed>>(new Map())
  const [extracting, setExtracting] = useState<Set<number>>(new Set())
  const aborts = useRef(new Map<number, AbortController>())
  const watching = useRef(new Set<number>())

  const patch = useCallback((nodeId: number, change: Partial<LiveReply> | null) => {
    setLive((prev) => {
      const next = new Map(prev)
      if (change === null) next.delete(nodeId)
      else {
        const cur = next.get(nodeId)
        if (!cur && !('running' in change)) return prev
        next.set(nodeId, { ...(cur as LiveReply), ...change })
      }
      return next
    })
  }, [])

  const refresh = useCallback(
    (subjectId: number) => qc.invalidateQueries({ queryKey: canvasKey(subjectId) }),
    [qc],
  )

  /** Poll the cartographer until it is idle, refreshing the canvas as it goes. */
  const watch = useCallback(
    (subjectId: number) => {
      if (watching.current.has(subjectId)) return
      watching.current.add(subjectId)
      const started = Date.now()
      let version: number | null = null
      const tick = async () => {
        const wait = pollInterval(Date.now() - started)
        if (wait === false) {
          watching.current.delete(subjectId)
          return
        }
        await new Promise((r) => setTimeout(r, wait))
        try {
          const s = await api.status(subjectId)
          if (version !== null && s.graph_version !== version) void refresh(subjectId)
          version = s.graph_version
          if (s.cartographer !== 'running') {
            watching.current.delete(subjectId)
            await refresh(subjectId)
            return
          }
        } catch {
          // A failed poll is retried on the next tick.
        }
        void tick()
      }
      void tick()
    },
    [refresh],
  )

  const ask = useCallback(
    async (subjectId: number, nodeId: number, message: string | null) => {
      const abort = new AbortController()
      aborts.current.set(nodeId, abort)
      patch(nodeId, { nodeId, question: message, text: '', running: true, stopping: false, error: null })
      let failure: Error | null = null
      const used: { ctx: ContextUsed | null } = { ctx: null }
      try {
        const result = await api.chat(nodeId, message, {
          signal: abort.signal,
          onStart: (start) => {
            used.ctx = start.context_used
          },
          onDelta: (t) =>
            setLive((prev) => {
              const cur = prev.get(nodeId)
              if (!cur) return prev
              const next = new Map(prev)
              next.set(nodeId, { ...cur, text: cur.text + t })
              return next
            }),
        })
        const savedId = result.messageId
        const ctx = used.ctx
        if (ctx && savedId) setContexts((prev) => new Map(prev).set(savedId, ctx))
        failure = result.error
      } catch (err) {
        failure = err as Error
      } finally {
        aborts.current.delete(nodeId)
      }
      await refresh(subjectId)
      if (failure && !(failure instanceof DOMException && failure.name === 'AbortError')) {
        patch(nodeId, { running: false, stopping: false, error: failure, question: null, text: '' })
      } else {
        patch(nodeId, null)
      }
      watch(subjectId)
    },
    [patch, refresh, watch],
  )

  const stop = useCallback(
    async (nodeId: number) => {
      patch(nodeId, { stopping: true })
      try {
        await api.stop(nodeId)
      } catch {
        // Not streaming on the server (or unreachable): drop the connection instead.
        aborts.current.get(nodeId)?.abort()
      }
    },
    [patch],
  )

  const retryExtract = useCallback(
    async (subjectId: number, nodeId: number) => {
      setExtracting((prev) => new Set(prev).add(nodeId))
      try {
        await api.extract(nodeId)
      } catch (err) {
        patch(nodeId, { nodeId, question: null, text: '', running: false, stopping: false, error: err as Error })
      } finally {
        setExtracting((prev) => {
          const next = new Set(prev)
          next.delete(nodeId)
          return next
        })
        await refresh(subjectId)
      }
    },
    [patch, refresh],
  )

  const dismissError = useCallback((nodeId: number) => patch(nodeId, null), [patch])

  const value = useMemo(
    () => ({ live, contexts, ask, stop, retryExtract, extracting, dismissError }),
    [live, contexts, ask, stop, retryExtract, extracting, dismissError],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
