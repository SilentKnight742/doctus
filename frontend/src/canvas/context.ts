import { createContext, useContext } from 'react'
import type { Canvas } from '../api/types'

/** What canvas cards need beyond their own node: the subject and panel actions. */
export interface CanvasCtx {
  subjectId: number
  canvas: Canvas
  /** Show a node's full conversation in the side panel. */
  open: (nodeId: number) => void
  /** Select a node (and keep it in place while the tree moves). */
  select: (nodeId: number) => void
  /** Bring a node into view if it is off screen (a branch just created). */
  reveal: (nodeId: number) => void
}

export const CanvasContext = createContext<CanvasCtx | null>(null)

export function useCanvasCtx(): CanvasCtx {
  const v = useContext(CanvasContext)
  if (!v) throw new Error('useCanvasCtx outside CanvasContext')
  return v
}
