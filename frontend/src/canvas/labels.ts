import type { CanvasNode } from '../api/types'

/** A short label for a node: its title, else its first question, else a placeholder. */
export function nodeLabel(n: CanvasNode | undefined): string {
  if (!n) return 'a removed node'
  if (n.title) return n.title
  if (n.kind === 'note') return n.note_body.split('\n')[0].slice(0, 60) || 'Note'
  const q = n.messages.find((m) => m.role === 'user')?.content ?? ''
  return q.length > 60 ? `${q.slice(0, 57)}…` : q || 'New chat'
}
