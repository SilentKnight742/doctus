/*
 * The prototype's in-browser database and every rule that guards it. Pure
 * TypeScript, no React: the mock API wraps it, and the unit tests pin the
 * rules N1 implements server-side.
 *
 * - Widget data is validated against its type on every write.
 * - Evidence rule: a reason needs two existing widgets of the same space.
 * - Deleting a widget deletes its reasons; deleting a world deletes its
 *   widgets (and so their reasons). Connections are derived, never stored.
 */
import { ApiError } from '../api/errors'
import type {
  ChatMessage,
  Connection,
  ConnectionView,
  Id,
  Reason,
  ReasonDetail,
  ReasonInput,
  SelectionInput,
  Space,
  SpaceView,
  Widget,
  WidgetInput,
  WidgetPatch,
  WidgetRef,
  WidgetType,
  World,
  WorldInput,
  WorldView,
} from '../api/types'
import { BUILTIN_TYPES } from '../schema/builtins'
import { ValidationError, validateData, validateType, widgetTitle } from '../schema/validate'

export interface DbState {
  next_id: number
  spaces: Space[]
  worlds: World[]
  widgets: Widget[]
  reasons: Reason[]
  /** Non-builtin widget types (builtins come from code). */
  types: WidgetType[]
  /** Chat history per scope key (`space:1`, `world:4`). */
  messages: Record<string, ChatMessage[]>
}

export function emptyState(): DbState {
  return { next_id: 1, spaces: [], worlds: [], widgets: [], reasons: [], types: [], messages: {} }
}

export const WORLD_SIZE = { w: 260, h: 150 }
export const COLOURS = ['indigo', 'teal', 'amber', 'rose', 'sky', 'olive', 'slate']

const notFound = (what: string, id: Id) => new ApiError(404, `${what} ${id} not found`)
const invalid = (msg: string) => new ApiError(422, msg)

function rethrow(e: unknown): never {
  if (e instanceof ValidationError) throw invalid(e.message)
  throw e
}

function clean(s: unknown, field: string, max = 500): string {
  if (typeof s !== 'string') throw invalid(`${field}: must be text`)
  const t = s.trim()
  if (t.length > max) throw invalid(`${field}: at most ${max} characters`)
  return t
}

function obj<T>(v: T, name: string): T {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${name}: must be an object`)
  return v
}

function num(v: unknown, field: string, fallback: number): number {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${field}: must be a number`)
  return v
}

export function pairKey(a: Id, b: Id): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

export class Db {
  state: DbState
  now: () => number

  constructor(state: DbState = emptyState(), now: () => number = Date.now) {
    this.state = state
    this.now = now
  }

  private id(): Id {
    return this.state.next_id++
  }

  // ---------- lookups ----------

  space(id: Id): Space {
    const s = this.state.spaces.find((x) => x.id === id)
    if (!s) throw notFound('Space', id)
    return s
  }

  world(id: Id): World {
    const w = this.state.worlds.find((x) => x.id === id)
    if (!w) throw notFound('World', id)
    return w
  }

  widget(id: Id): Widget {
    const w = this.state.widgets.find((x) => x.id === id)
    if (!w) throw notFound('Widget', id)
    return w
  }

  reason(id: Id): Reason {
    const r = this.state.reasons.find((x) => x.id === id)
    if (!r) throw notFound('Reason', id)
    return r
  }

  typesFor(spaceId: Id): WidgetType[] {
    return [...BUILTIN_TYPES, ...this.state.types.filter((t) => t.space_id === spaceId)]
  }

  type(spaceId: Id, name: string): WidgetType {
    const t = this.typesFor(spaceId).find((x) => x.name === name)
    if (!t) throw invalid(`type: no widget type "${name}" in this space`)
    return t
  }

  private refChecker(spaceId: Id) {
    return (ref: { kind: 'widget' | 'world'; id: Id }) =>
      ref.kind === 'world'
        ? this.state.worlds.some((w) => w.id === ref.id && w.space_id === spaceId)
        : this.state.widgets.some((w) => w.id === ref.id && w.space_id === spaceId)
  }

  // ---------- spaces ----------

  createSpace(title: string, description = ''): Space {
    const t = clean(title, 'title', 120)
    if (!t) throw invalid('title: required')
    const space: Space = { id: this.id(), title: t, description: clean(description, 'description'), created_at: this.now() }
    this.state.spaces.push(space)
    return space
  }

  updateSpace(id: Id, patch: { title?: string; description?: string }): Space {
    const s = this.space(id)
    if (patch.title !== undefined) {
      const t = clean(patch.title, 'title', 120)
      if (!t) throw invalid('title: required')
      s.title = t
    }
    if (patch.description !== undefined) s.description = clean(patch.description, 'description')
    return s
  }

  deleteSpace(id: Id) {
    this.space(id)
    for (const w of this.state.worlds.filter((x) => x.space_id === id)) this.deleteWorld(w.id)
    for (const w of this.state.widgets.filter((x) => x.space_id === id)) this.deleteWidget(w.id)
    this.state.types = this.state.types.filter((t) => t.space_id !== id)
    this.state.spaces = this.state.spaces.filter((s) => s.id !== id)
    delete this.state.messages[`space:${id}`]
  }

  /** Register a non-builtin widget type on a space (the user/AI-defined path). */
  defineType(type: WidgetType): WidgetType {
    this.space(type.space_id ?? -1)
    if (type.builtin) throw invalid('builtin: only Doctus ships builtin types')
    const errors = validateType(type)
    if (errors.length) throw invalid(errors.join('; '))
    if (this.typesFor(type.space_id!).some((t) => t.name === type.name)) throw invalid(`name: "${type.name}" exists`)
    this.state.types.push(type)
    return type
  }

  // ---------- worlds ----------

  createWorld(spaceId: Id, input: WorldInput): World {
    obj(input, 'input')
    this.space(spaceId)
    const title = clean(input.title, 'title', 120)
    if (!title) throw invalid('title: required')
    const count = this.state.worlds.filter((w) => w.space_id === spaceId).length
    const world: World = {
      id: this.id(),
      space_id: spaceId,
      title,
      summary: clean(input.summary ?? '', 'summary'),
      colour: COLOURS.includes(input.colour ?? '') ? input.colour! : COLOURS[count % COLOURS.length],
      x: num(input.x, 'x', 80 + (count % 3) * 340),
      y: num(input.y, 'y', 80 + Math.floor(count / 3) * 240),
      ...WORLD_SIZE,
      created_at: this.now(),
    }
    this.state.worlds.push(world)
    return world
  }

  updateWorld(id: Id, patch: Partial<Pick<World, 'title' | 'summary' | 'colour' | 'x' | 'y'>>): World {
    obj(patch, 'patch')
    const w = this.world(id)
    if (patch.title !== undefined) {
      const t = clean(patch.title, 'title', 120)
      if (!t) throw invalid('title: required')
      w.title = t
    }
    if (patch.summary !== undefined) w.summary = clean(patch.summary, 'summary')
    if (patch.colour !== undefined) {
      if (!COLOURS.includes(patch.colour)) throw invalid(`colour: one of ${COLOURS.join(', ')}`)
      w.colour = patch.colour
    }
    w.x = num(patch.x, 'x', w.x)
    w.y = num(patch.y, 'y', w.y)
    return w
  }

  deleteWorld(id: Id) {
    this.world(id)
    for (const w of this.state.widgets.filter((x) => x.world_id === id)) this.deleteWidget(w.id)
    this.state.worlds = this.state.worlds.filter((w) => w.id !== id)
    delete this.state.messages[`world:${id}`]
  }

  // ---------- widgets ----------

  createWidget(input: WidgetInput): Widget {
    obj(input, 'input')
    let spaceId: Id
    let worldId: Id | null = null
    if (input.world_id != null) {
      const world = this.world(input.world_id)
      spaceId = world.space_id
      worldId = world.id
    } else {
      if (input.space_id == null) throw invalid('world_id or space_id: required')
      spaceId = this.space(input.space_id).id
    }
    const type = this.type(spaceId, input.type)
    let data
    try {
      data = validateData(type, input.data, this.refChecker(spaceId))
    } catch (e) {
      rethrow(e)
    }
    const siblings = this.state.widgets.filter((w) => w.world_id === worldId && w.space_id === spaceId).length
    const widget: Widget = {
      id: this.id(),
      space_id: spaceId,
      world_id: worldId,
      type: type.name,
      data,
      x: num(input.x, 'x', 40 + (siblings % 3) * 400),
      y: num(input.y, 'y', 40 + Math.floor(siblings / 3) * 340),
      w: Math.max(160, num(input.w, 'w', type.default_size.w)),
      h: Math.max(80, num(input.h, 'h', type.default_size.h)),
      copied_from: null,
      created_at: this.now(),
    }
    this.state.widgets.push(widget)
    return widget
  }

  updateWidget(id: Id, patch: WidgetPatch): Widget {
    obj(patch, 'patch')
    const w = this.widget(id)
    if (patch.data !== undefined) {
      const type = this.type(w.space_id, w.type)
      try {
        w.data = validateData(type, { ...w.data, ...patch.data }, this.refChecker(w.space_id))
      } catch (e) {
        rethrow(e)
      }
    }
    w.x = num(patch.x, 'x', w.x)
    w.y = num(patch.y, 'y', w.y)
    w.w = Math.max(160, num(patch.w, 'w', w.w))
    w.h = Math.max(80, num(patch.h, 'h', w.h))
    return w
  }

  /** Deletes the widget and every reason that points to it. */
  deleteWidget(id: Id) {
    this.widget(id)
    this.state.widgets = this.state.widgets.filter((w) => w.id !== id)
    this.state.reasons = this.state.reasons.filter((r) => r.widget_a !== id && r.widget_b !== id)
    for (const w of this.state.widgets) if (w.copied_from === id) w.copied_from = null
  }

  // ---------- reasons ----------

  /** The evidence rule: both widgets exist, differ, live in worlds of one space. */
  createReason(input: ReasonInput): Reason {
    obj(input, 'input')
    const ids = [input.widget_a, input.widget_b]
    const [a, b] = ids.map((id) => {
      const w = this.state.widgets.find((x) => x.id === id)
      if (!w) throw invalid(`widget ${id}: does not exist (a reason needs evidence)`)
      if (w.world_id == null) throw invalid(`widget ${id}: is not in a world`)
      return w
    })
    if (a.id === b.id) throw invalid('widget_b: must differ from widget_a')
    if (a.space_id !== b.space_id) throw invalid('widgets: must be in the same space')
    const kind = clean(input.kind, 'kind', 40)
    const text = clean(input.text, 'text', 300)
    if (!kind) throw invalid('kind: required')
    if (!text) throw invalid('text: required')
    if (input.author !== 'ai' && input.author !== 'user') throw invalid('author: ai or user')
    const reason: Reason = {
      id: this.id(),
      widget_a: a.id,
      widget_b: b.id,
      kind,
      text,
      author: input.author,
      created_at: this.now(),
    }
    this.state.reasons.push(reason)
    return reason
  }

  updateReason(id: Id, patch: { kind?: string; text?: string }): Reason {
    obj(patch, 'patch')
    const r = this.reason(id)
    if (patch.kind !== undefined) {
      const k = clean(patch.kind, 'kind', 40)
      if (!k) throw invalid('kind: required')
      r.kind = k
    }
    if (patch.text !== undefined) {
      const t = clean(patch.text, 'text', 300)
      if (!t) throw invalid('text: required')
      r.text = t
    }
    return r
  }

  deleteReason(id: Id) {
    this.reason(id)
    this.state.reasons = this.state.reasons.filter((r) => r.id !== id)
  }

  // ---------- derived ----------

  /** One connection per pair of distinct worlds with at least one reason. */
  connections(spaceId: Id): Connection[] {
    const byPair = new Map<string, Connection>()
    const worldOf = new Map(this.state.widgets.map((w) => [w.id, w]))
    for (const r of this.state.reasons) {
      const a = worldOf.get(r.widget_a)
      const b = worldOf.get(r.widget_b)
      if (!a || !b || a.space_id !== spaceId || a.world_id == null || b.world_id == null) continue
      if (a.world_id === b.world_id) continue
      const key = pairKey(a.world_id, b.world_id)
      const c = byPair.get(key)
      if (c) c.reason_count++
      else
        byPair.set(key, {
          key,
          world_a: Math.min(a.world_id, b.world_id),
          world_b: Math.max(a.world_id, b.world_id),
          reason_count: 1,
        })
    }
    return [...byPair.values()].sort((x, y) => x.key.localeCompare(y.key))
  }

  widgetRef(id: Id): WidgetRef {
    const w = this.widget(id)
    const world = w.world_id == null ? null : this.world(w.world_id)
    return {
      id: w.id,
      type: w.type,
      title: widgetTitle(this.typesFor(w.space_id).find((t) => t.name === w.type), w.data),
      world_id: w.world_id,
      world_title: world?.title ?? 'Space',
    }
  }

  detail(r: Reason): ReasonDetail {
    return { ...r, a: this.widgetRef(r.widget_a), b: this.widgetRef(r.widget_b) }
  }

  spaceView(id: Id): SpaceView {
    const space = this.space(id)
    const worlds = this.state.worlds
      .filter((w) => w.space_id === id)
      .map((w) => {
        const widgets = this.state.widgets.filter((x) => x.world_id === w.id)
        return { ...w, widget_count: widgets.length, widget_types: widgets.map((x) => x.type) }
      })
    return {
      space,
      worlds,
      connections: this.connections(id),
      space_widgets: this.state.widgets.filter((w) => w.space_id === id && w.world_id == null),
      widget_types: this.typesFor(id),
    }
  }

  worldView(id: Id): WorldView {
    const world = this.world(id)
    const widgets = this.state.widgets.filter((w) => w.world_id === id)
    const ids = new Set(widgets.map((w) => w.id))
    return {
      space: this.space(world.space_id),
      world,
      widgets,
      reasons: this.state.reasons.filter((r) => ids.has(r.widget_a) || ids.has(r.widget_b)).map((r) => this.detail(r)),
      origins: widgets
        .map((w) => w.copied_from)
        .filter((o): o is Id => o != null && this.state.widgets.some((x) => x.id === o))
        .map((o) => this.widgetRef(o)),
      widget_types: this.typesFor(world.space_id),
    }
  }

  connectionView(worldA: Id, worldB: Id): ConnectionView {
    const a = this.world(worldA)
    const b = this.world(worldB)
    const key = pairKey(a.id, b.id)
    const connection = this.connections(a.space_id).find((c) => c.key === key)
    if (!connection) throw new ApiError(404, 'These worlds are not connected')
    const inPair = (w: Id) => {
      const wid = this.state.widgets.find((x) => x.id === w)?.world_id
      return wid === a.id || wid === b.id
    }
    const worldOf = (w: Id) => this.state.widgets.find((x) => x.id === w)?.world_id
    const reasons = this.state.reasons
      .filter((r) => inPair(r.widget_a) && inPair(r.widget_b) && worldOf(r.widget_a) !== worldOf(r.widget_b))
      .map((r) => this.detail(r))
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a]
    return { connection, worlds: [lo, hi], reasons }
  }

  // ---------- new world from selection ----------

  /**
   * Create a world holding the widgets the selected reasons reference.
   * copy (default): copies keep `copied_from`, and the selected reasons are
   * copied onto the copies. move: the widgets move, keeping all their reasons.
   */
  newWorldFromSelection(input: SelectionInput): World {
    obj(input, 'input')
    this.space(input.space_id)
    if (!Array.isArray(input.reason_ids) || !input.reason_ids.length) throw invalid('reason_ids: select at least one')
    if (input.mode !== 'copy' && input.mode !== 'move') throw invalid('mode: copy or move')
    const reasons = [...new Set(input.reason_ids)].map((id) => this.reason(id))
    const widgetIds: Id[] = []
    for (const r of reasons)
      for (const w of [r.widget_a, r.widget_b]) {
        if (this.widget(w).space_id !== input.space_id) throw invalid(`reason ${r.id}: not in this space`)
        if (!widgetIds.includes(w)) widgetIds.push(w)
      }
    const world = this.createWorld(input.space_id, {
      title: input.title,
      summary: `Made from ${reasons.length} reason${reasons.length === 1 ? '' : 's'} (${input.mode}).`,
      x: input.x,
      y: input.y,
    })
    const cols = Math.min(3, widgetIds.length)
    const place = (i: number) => ({ x: 40 + (i % cols) * 400, y: 40 + Math.floor(i / cols) * 340 })
    if (input.mode === 'move') {
      widgetIds.forEach((id, i) => Object.assign(this.widget(id), { world_id: world.id }, place(i)))
      return world
    }
    const copyOf = new Map<Id, Id>()
    widgetIds.forEach((id, i) => {
      const src = this.widget(id)
      const copy: Widget = {
        ...structuredClone(src),
        id: this.id(),
        world_id: world.id,
        copied_from: src.id,
        created_at: this.now(),
        ...place(i),
      }
      this.state.widgets.push(copy)
      copyOf.set(src.id, copy.id)
    })
    for (const r of reasons)
      this.state.reasons.push({
        ...r,
        id: this.id(),
        widget_a: copyOf.get(r.widget_a)!,
        widget_b: copyOf.get(r.widget_b)!,
        created_at: this.now(),
      })
    return world
  }

  // ---------- chat ----------

  messages(key: string): ChatMessage[] {
    return this.state.messages[key] ?? []
  }

  addMessage(key: string, msg: Omit<ChatMessage, 'id' | 'created_at'>): ChatMessage {
    const m: ChatMessage = { ...msg, id: this.id(), created_at: this.now() }
    ;(this.state.messages[key] ??= []).push(m)
    return m
  }
}
