export type EdgeKind = 'prerequisite' | 'part_of' | 'related'
export type CartographerState = 'idle' | 'running' | 'error'

export interface Subject {
  id: number
  title: string
  goal: string
  created_at: number
  origin_node_id: number | null
  graph_version: number
  cartographer_state: CartographerState
}

export interface GraphNode {
  id: number
  name: string
  summary: string
  strength: number
  level: string
  last_visited_at: number | null
  distance?: number | null
}

export interface GraphEdge {
  id: number
  source: number
  target: number
  kind: EdgeKind
  reason: string
}

export interface TrailStep {
  node_id: number
  from_node_id: number | null
  at: number
}

export interface GraphStatus {
  graph_version: number
  cartographer: CartographerState
  error: string | null
}

export interface Graph extends GraphStatus {
  subject: Subject
  nodes: GraphNode[]
  edges: GraphEdge[]
  trail: TrailStep[]
}

export interface Brief {
  id: number
  name: string
  summary?: string
}

export interface ContextUsed {
  node?: Brief
  prerequisites?: Brief[]
  part_of?: Brief | null
  parts?: Brief[]
  nearby?: Brief[]
  recent_turns?: number
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export interface NodeDetail {
  node: GraphNode
  evidence: { message_id: number; quote: string }[]
  edges: GraphEdge[]
  context: ContextUsed
  messages: Message[]
}

export interface ChatReply extends GraphStatus {
  reply: string
  context_used: ContextUsed
}
