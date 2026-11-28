/*
 * The v2 data shapes. The prototype's mock API returns exactly these; N1's
 * FastAPI backend implements the same shapes (snake_case on purpose).
 */

export type Id = number

// ---------- widget types (data-defined) ----------

export type PrimitiveType =
  | 'text' // Markdown
  | 'number'
  | 'date' // YYYY-MM-DD, or '' when unset
  | 'bool'
  | 'enum'
  | 'url'
  | 'file' // an image or a document
  | 'ref' // another widget or world
  | 'code'
  | 'list' // rows of typed fields, shown stacked
  | 'table' // rows of typed fields, shown as a grid

export interface FieldDef {
  key: string
  label: string
  type: PrimitiveType
  required?: boolean
  /** enum: the allowed values. */
  options?: string[]
  /** code: the language, for display. */
  language?: string
  /** ref: what it may point to. */
  ref_kind?: 'widget' | 'world'
  /** list / table: the fields of one row (primitives only, no nesting). */
  fields?: FieldDef[]
}

export type ViewTemplate = 'card' | 'table' | 'list' | 'checklist' | 'embed' | 'image'

export interface ViewOptions {
  /** The field shown as the widget's title (also its name in reasons). */
  title?: string
  /** table: a list field whose rows' `name` label the item columns, in order. */
  columns?: string
  /** A field whose value prefixes the title in names (`GET /pet`). */
  title_prefix?: string
  /** A text field shown right under the title, without a label. */
  lead?: string
  /** An enum field shown as a coloured badge next to the title. */
  badge?: string
  /** table / list / checklist: the list or table field that holds the rows. */
  items?: string
  /** checklist: the bool field of a row that is ticked. */
  check?: string
  /** table: a progress bar counting rows whose `by` field equals `done`. */
  progress?: { by: string; done: string }
}

export interface WidgetType {
  /** Stable key, e.g. `note`, `openapi_endpoint`, `decision`. */
  name: string
  label: string
  description: string
  /** Built in (ships with Doctus) or defined by a user or the AI. */
  builtin: boolean
  /** The space a non-builtin type belongs to (null for builtins). */
  space_id: Id | null
  view: ViewTemplate
  view_options: ViewOptions
  fields: FieldDef[]
  /** Default size on a canvas, px. */
  default_size: { w: number; h: number }
}

/** A file value: a stored upload (later) or a bundled asset (prototype). */
export interface FileValue {
  name: string
  src: string
  kind: 'image' | 'document'
}

export interface RefValue {
  kind: 'widget' | 'world'
  id: Id
}

export type FieldValue = string | number | boolean | FileValue | RefValue | null | Row[]
export type Row = Record<string, FieldValue>
export type WidgetData = Record<string, FieldValue>

// ---------- spaces, worlds, widgets, reasons ----------

export interface Space {
  id: Id
  title: string
  description: string
  created_at: number
}

export interface World {
  id: Id
  space_id: Id
  title: string
  summary: string
  colour: string
  x: number
  y: number
  w: number
  h: number
  created_at: number
}

export interface Widget {
  id: Id
  space_id: Id
  /** null: a space-level widget (trackers), not inside any world. */
  world_id: Id | null
  type: string
  data: WidgetData
  x: number
  y: number
  w: number
  h: number
  /** The widget this one was copied from ("New world from selection"). */
  copied_from: Id | null
  created_at: number
}

export type Author = 'ai' | 'user'

export interface Reason {
  id: Id
  widget_a: Id
  widget_b: Id
  kind: string
  text: string
  author: Author
  created_at: number
}

// ---------- views (what the API returns for a screen) ----------

export interface WorldSummary extends World {
  widget_count: number
  /** The type names of its widgets, in order, for the card preview. */
  widget_types: string[]
}

/** Derived: exists iff at least one reason links the two worlds. */
export interface Connection {
  /** `${world_a}-${world_b}` with world_a < world_b. */
  key: string
  world_a: Id
  world_b: Id
  reason_count: number
}

export interface SpaceView {
  space: Space
  worlds: WorldSummary[]
  connections: Connection[]
  space_widgets: Widget[]
  widget_types: WidgetType[]
}

/** A widget as seen from a reason: enough to name it and jump to it. */
export interface WidgetRef {
  id: Id
  type: string
  title: string
  world_id: Id | null
  world_title: string
}

export interface ReasonDetail extends Reason {
  a: WidgetRef
  b: WidgetRef
}

export interface ConnectionView {
  connection: Connection
  worlds: [World, World]
  reasons: ReasonDetail[]
}

export interface WorldView {
  space: Space
  world: World
  widgets: Widget[]
  /** Every reason touching a widget of this world. */
  reasons: ReasonDetail[]
  /** The originals of copied widgets (those that still exist). */
  origins: WidgetRef[]
  widget_types: WidgetType[]
}

// ---------- chat ----------

export type ChatScope = { kind: 'space'; id: Id } | { kind: 'world'; id: Id }

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; summary: string; ok: boolean }

export interface ChatMessage {
  id: Id
  role: 'user' | 'assistant'
  parts: MessagePart[]
  stopped: boolean
  /** Messages a space agent sent to a world agent are marked. */
  from_space_agent?: boolean
  created_at: number
}

export interface ChatEvents {
  onText?: (text: string) => void
  onTool?: (part: Extract<MessagePart, { type: 'tool' }>) => void
  signal?: AbortSignal
}

/** A prompt the (scripted) agent knows how to answer, shown as a chip. */
export interface PromptSuggestion {
  id: string
  label: string
}

// ---------- inputs ----------

export interface WorldInput {
  title: string
  summary?: string
  colour?: string
  x?: number
  y?: number
}

export interface WidgetInput {
  type: string
  data: WidgetData
  world_id?: Id | null
  space_id?: Id
  x?: number
  y?: number
  w?: number
  h?: number
}

export interface WidgetPatch {
  data?: WidgetData
  x?: number
  y?: number
  w?: number
  h?: number
}

export interface ReasonInput {
  widget_a: Id
  widget_b: Id
  kind: string
  text: string
  author: Author
}

export interface SelectionInput {
  space_id: Id
  reason_ids: Id[]
  title: string
  mode: 'copy' | 'move'
  x?: number
  y?: number
}
