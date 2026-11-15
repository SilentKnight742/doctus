import { createContext, useContext } from 'react'
import type { ContextUsed, Graph, GraphNode, GraphStatus } from '../api/types'
import type { Point } from '../graph/layout'

export interface SubjectState {
  subjectId: number
  graph: Graph | undefined
  graphError: unknown
  status: GraphStatus | undefined
  nodesById: Map<number, GraphNode>
  positions: Map<number, Point>
  tidy: () => void
  freshIds: Set<number>
  /** Tell the poller a cartographer run has started (from a chat reply). */
  noteStatus: (s: GraphStatus) => void
  /** Where the learner came from when they opened a node (for the trail). */
  arrivedFrom: (nodeId: number) => number | null
  openFrom: (nodeId: number, fromNodeId: number | null) => void
  /** "context used" records for replies received in this session. */
  contextFor: (messageId: number) => ContextUsed | undefined
  setContext: (messageId: number, ctx: ContextUsed) => void
  draft: (nodeId: number) => string
  setDraft: (nodeId: number, text: string) => void
}

export const Ctx = createContext<SubjectState | null>(null)

export function useSubject(): SubjectState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSubject outside SubjectProvider')
  return v
}
