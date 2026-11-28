/*
 * The agent tools, as N2 will expose them to the space and world agents (and
 * N5 over MCP). Every call goes through the Db, so it is validated exactly
 * like a call from the UI. A world agent may only touch its own world.
 */
import { ApiError } from '../../api/errors'
import type { ChatScope, Id, WidgetData, WidgetType } from '../../api/types'
import type { Db } from '../db'

export interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  summary: string
  /** The id of what was created, when anything was. */
  id?: Id
}

export const SPACE_TOOLS = [
  'create_world',
  'create_widget',
  'create_space_widget',
  'update_widget',
  'add_reason',
  'define_type',
] as const
export const WORLD_TOOLS = ['create_widget', 'update_widget', 'delete_widget', 'arrange_widgets'] as const

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const id = (v: unknown, name: string): Id => {
  if (typeof v !== 'number') throw new ApiError(422, `${name}: must be an id`)
  return v
}

function spaceOf(db: Db, scope: ChatScope): Id {
  return scope.kind === 'space' ? scope.id : db.world(scope.id).space_id
}

/** Run one tool call. Never throws: a rejected call comes back as `ok: false`. */
export function runTool(db: Db, scope: ChatScope, call: ToolCall): ToolResult {
  const allowed: readonly string[] = scope.kind === 'space' ? SPACE_TOOLS : WORLD_TOOLS
  if (!allowed.includes(call.tool))
    return { ok: false, summary: `${call.tool}: not a ${scope.kind} agent tool` }
  try {
    return exec(db, scope, call)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, summary: `${call.tool} rejected: ${msg}` }
  }
}

function inScopeWorld(db: Db, scope: ChatScope, worldId: Id) {
  if (scope.kind === 'world' && worldId !== scope.id) throw new ApiError(422, 'world_id: a world agent works in its own world')
  if (scope.kind === 'space' && db.world(worldId).space_id !== scope.id) throw new ApiError(422, 'world_id: not in this space')
}

function exec(db: Db, scope: ChatScope, { tool, args: a }: ToolCall): ToolResult {
  const spaceId = spaceOf(db, scope)
  switch (tool) {
    case 'create_world': {
      const w = db.createWorld(spaceId, {
        title: str(a.title),
        summary: str(a.summary),
        colour: str(a.colour) || undefined,
        x: a.x as number | undefined,
        y: a.y as number | undefined,
      })
      return { ok: true, summary: `Created world “${w.title}”`, id: w.id }
    }
    case 'create_widget': {
      const worldId = scope.kind === 'world' && a.world_id === undefined ? scope.id : id(a.world_id, 'world_id')
      inScopeWorld(db, scope, worldId)
      const w = db.createWidget({
        world_id: worldId,
        type: str(a.type),
        data: a.data as WidgetData,
        x: a.x as number | undefined,
        y: a.y as number | undefined,
        w: a.w as number | undefined,
        h: a.h as number | undefined,
      })
      const ref = db.widgetRef(w.id)
      return { ok: true, summary: `Added ${label(db, spaceId, w.type)} “${ref.title}” to ${ref.world_title}`, id: w.id }
    }
    case 'create_space_widget': {
      const w = db.createWidget({ space_id: spaceId, world_id: null, type: str(a.type), data: a.data as WidgetData })
      return { ok: true, summary: `Added space ${label(db, spaceId, w.type)} “${db.widgetRef(w.id).title}”`, id: w.id }
    }
    case 'update_widget': {
      const w = db.widget(id(a.widget_id, 'widget_id'))
      if (scope.kind === 'world') inScopeWorld(db, scope, w.world_id ?? -1)
      else if (w.space_id !== spaceId) throw new ApiError(422, 'widget_id: not in this space')
      db.updateWidget(w.id, { data: a.data as WidgetData })
      return { ok: true, summary: `Updated “${db.widgetRef(w.id).title}”`, id: w.id }
    }
    case 'delete_widget': {
      const w = db.widget(id(a.widget_id, 'widget_id'))
      inScopeWorld(db, scope, w.world_id ?? -1)
      const title = db.widgetRef(w.id).title
      db.deleteWidget(w.id)
      return { ok: true, summary: `Deleted “${title}” and its reasons` }
    }
    case 'arrange_widgets': {
      const worldId = scope.kind === 'world' ? scope.id : id(a.world_id, 'world_id')
      const cols = typeof a.columns === 'number' && a.columns > 0 ? Math.floor(a.columns) : 3
      const widgets = db.state.widgets.filter((w) => w.world_id === worldId)
      const rowH: number[] = []
      widgets.forEach((w, i) => {
        const r = Math.floor(i / cols)
        rowH[r] = Math.max(rowH[r] ?? 0, w.h)
      })
      const colW = Math.max(...widgets.map((w) => w.w), 200) + 40
      widgets.forEach((w, i) => {
        const r = Math.floor(i / cols)
        const y = 40 + rowH.slice(0, r).reduce((s, h) => s + h + 40, 0)
        db.updateWidget(w.id, { x: 40 + (i % cols) * colW, y })
      })
      return { ok: true, summary: `Arranged ${widgets.length} widgets in ${cols} columns` }
    }
    case 'add_reason': {
      const r = db.createReason({
        widget_a: id(a.widget_a, 'widget_a'),
        widget_b: id(a.widget_b, 'widget_b'),
        kind: str(a.kind),
        text: str(a.text),
        author: 'ai',
      })
      const d = db.detail(r)
      return { ok: true, summary: `Linked “${d.a.title}” ↔ “${d.b.title}” (${r.kind})`, id: r.id }
    }
    case 'define_type': {
      const t = db.defineType({ ...(a.type as WidgetType), space_id: spaceId, builtin: false })
      return { ok: true, summary: `Defined widget type “${t.label}” (${t.fields.length} fields)` }
    }
  }
  return { ok: false, summary: `${tool}: unknown tool` }
}

function label(db: Db, spaceId: Id, type: string): string {
  return (db.typesFor(spaceId).find((t) => t.name === type)?.label ?? type).toLowerCase()
}
