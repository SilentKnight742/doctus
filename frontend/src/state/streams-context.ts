import { createContext, useContext } from 'react'
import type { ApiError } from '../api/client'
import type { ContextUsed } from '../api/types'

/** A tutor reply being written (or one that just failed) in a chat node. */
export interface LiveReply {
  nodeId: number
  /** The learner's new message, shown until the canvas refetch has it. */
  question: string | null
  text: string
  running: boolean
  stopping: boolean
  error: ApiError | Error | null
}

interface Streams {
  live: ReadonlyMap<number, LiveReply>
  /** Context the tutor was given, by assistant message id (this session only). */
  contexts: ReadonlyMap<number, ContextUsed>
  /** Ask in a chat node; `message` null answers its waiting question. */
  ask: (subjectId: number, nodeId: number, message: string | null) => Promise<void>
  stop: (nodeId: number) => Promise<void>
  /** Re-run the cartographer on a node whose extraction failed. */
  retryExtract: (subjectId: number, nodeId: number) => Promise<void>
  extracting: ReadonlySet<number>
  dismissError: (nodeId: number) => void
}

export const Ctx = createContext<Streams | null>(null)

export const canvasKey = (subjectId: number) => ['canvas', subjectId] as const

export function useStreams(): Streams {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStreams outside StreamsProvider')
  return v
}
