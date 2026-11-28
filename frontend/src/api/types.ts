export type CartographerState = 'idle' | 'running' | 'error'
export type CanvasNodeKind = 'chat' | 'note'

export interface Subject {
  id: number
  title: string
  goal: string
  created_at: number
  root_canvas_node_id: number
  graph_version: number
  cartographer_state: CartographerState
}

export interface CanvasStatus {
  graph_version: number
  cartographer: CartographerState
  error: string | null
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  stopped: boolean
  created_at: number
}

/** A concept taught in a node: `home` when it was first taught there. */
export interface ConceptChip {
  id: number
  name: string
  home: boolean
  home_canvas_node_id: number | null
}

export interface CanvasNode {
  id: number
  parent_id: number | null
  kind: CanvasNodeKind
  sort_index: number
  title: string
  keyword: string
  note_body: string
  is_root: boolean
  answered: boolean
  /** The latest message is a question still waiting for the tutor. */
  pending: boolean
  streaming: boolean
  /** A reply the cartographer has not processed yet (waiting, or failed). */
  extract_pending: boolean
  concepts: ConceptChip[]
  messages: Message[]
}

export interface ConceptLink {
  id: number
  kind: 'prerequisite' | 'related'
  reason: string
  from_concept: { id: number; name: string }
  to_concept: { id: number; name: string }
  from_node: number
  to_node: number
}

export interface Suggestion {
  id: number
  canvas_node_id: number
  text: string
}

export interface Canvas extends CanvasStatus {
  subject: Subject
  root_id: number
  nodes: CanvasNode[]
  links: ConceptLink[]
  suggestions: Suggestion[]
}

/** What background the tutor was given for one reply (development aid). */
export interface ContextUsed {
  branch?: { id: number; kind: CanvasNodeKind; title: string }[]
  included_nodes?: number[]
  trimmed_nodes?: { id: number; title: string }[]
  notes?: number[]
  concepts?: { id: number; name: string }[]
  prerequisites?: { id: number; name: string }[]
  history_messages?: number
  budget_chars?: number
}

export interface StreamStart {
  user_message_id: number
  context_used: ContextUsed
}

export interface StreamDone extends CanvasStatus {
  message_id: number | null
  stopped: boolean
}
