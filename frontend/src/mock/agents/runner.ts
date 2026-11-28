/*
 * The scripted agent: plays a canned conversation step by step, streaming
 * its text and applying its tool calls through `runTool` (so they are
 * validated like any other write). Clearly a demo; N2 replaces it with a
 * model that chooses the steps itself.
 *
 * Scripts name things by title (`@world:Pets endpoints`,
 * `@widget:Pets endpoints#GET /pet/{petId}`); the runner resolves them to
 * ids just before each call.
 */
import type { ChatEvents, ChatMessage, ChatScope, MessagePart, PromptSuggestion } from '../../api/types'
import { widgetTitle } from '../../schema/validate'
import type { Db } from '../db'
import { runTool, type ToolCall } from './tools'

export type Step =
  | { say: string }
  | { call: ToolCall }
  /** A space agent instructing a world agent, which then runs `steps`. */
  | { instruct: string; instruction: string; steps: Step[] }
  /** Steps decided from the current data (e.g. "only links not made yet"). */
  | { dynamic: (db: Db, scope: ChatScope) => Step[] }

export interface Script {
  id: string
  scope: 'space' | 'world'
  label: string
  /** When the chip is offered. */
  when: (db: Db, scope: ChatScope) => boolean
  steps: Step[]
}

export interface Pace {
  /** Wait between pieces; `instant` (seeding, tests) skips waiting. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  instant: boolean
}

export const realPace: Pace = {
  instant: false,
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      })
    }),
}

export const instantPace: Pace = { instant: true, sleep: async () => {} }

export function scopeKey(scope: ChatScope): string {
  return `${scope.kind}:${scope.id}`
}

/** Resolve `@world:` / `@widget:` names anywhere in a value. */
export function resolveRefs(db: Db, spaceId: number, value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('@world:')) {
      const title = value.slice(7)
      const w = db.state.worlds.find((x) => x.space_id === spaceId && x.title === title)
      if (!w) throw new Error(`no world “${title}”`)
      return w.id
    }
    if (value.startsWith('@widget:')) {
      const cut = value.indexOf('#')
      const worldTitle = value.slice(8, cut)
      const title = value.slice(cut + 1)
      const world = db.state.worlds.find((x) => x.space_id === spaceId && x.title === worldTitle)
      const types = db.typesFor(spaceId)
      const w = db.state.widgets.find(
        (x) =>
          x.space_id === spaceId &&
          (world ? x.world_id === world.id : x.world_id == null && worldTitle === 'Space') &&
          widgetTitle(
            types.find((t) => t.name === x.type),
            x.data,
          ) === title,
      )
      if (!w) throw new Error(`no widget “${title}” in ${worldTitle}`)
      return w.id
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(db, spaceId, v))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(db, spaceId, v)]))
  return value
}

const CANNED =
  'This is the **prototype**: the agents here are scripted, not a model. ' +
  'Try one of the suggested prompts below to watch an agent work. ' +
  'In the real product (N2) this chat goes to Gemini, Anthropic or OpenAI.'

function chunks(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; ) {
    const n = 2 + ((i * 7) % 4)
    out.push(text.slice(i, i + n))
    i += n
  }
  return out
}

export function suggestionsFor(db: Db, scope: ChatScope, scripts: Script[]): PromptSuggestion[] {
  return scripts
    .filter((s) => s.scope === scope.kind && safeWhen(s, db, scope))
    .map((s) => ({ id: s.id, label: s.label }))
}

function safeWhen(s: Script, db: Db, scope: ChatScope) {
  try {
    return s.when(db, scope)
  } catch {
    return false
  }
}

export function findScript(db: Db, scope: ChatScope, text: string, scripts: Script[]): Script | null {
  const t = text.trim().toLowerCase()
  return (
    scripts.find(
      (s) => s.scope === scope.kind && (s.id === t || s.label.toLowerCase() === t) && safeWhen(s, db, scope),
    ) ?? null
  )
}

interface Ctx {
  db: Db
  pace: Pace
  events: ChatEvents
  onChange: () => void
}

/**
 * Answer `text` in `scope`: save the user's message, play the matching
 * script (or the canned reply), save the assistant's message. A stop keeps
 * what was said and done so far, marked as stopped.
 */
export async function answer(
  db: Db,
  scope: ChatScope,
  text: string,
  scripts: Script[],
  events: ChatEvents,
  pace: Pace,
  onChange: () => void,
): Promise<ChatMessage> {
  const key = scopeKey(scope)
  db.addMessage(key, { role: 'user', parts: [{ type: 'text', text }], stopped: false })
  onChange()
  const script = findScript(db, scope, text, scripts)
  const steps: Step[] = script ? script.steps : [{ say: CANNED }]
  const parts: MessagePart[] = []
  await play(steps, scope, parts, { db, pace, events, onChange })
  const stopped = !!events.signal?.aborted
  const msg = db.addMessage(key, { role: 'assistant', parts: merge(parts), stopped })
  onChange()
  return msg
}

function merge(parts: MessagePart[]): MessagePart[] {
  const out: MessagePart[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (p.type === 'text' && last?.type === 'text') last.text += p.text
    else out.push({ ...p })
  }
  return out
}

async function play(steps: Step[], scope: ChatScope, parts: MessagePart[], ctx: Ctx) {
  const { db, pace, events } = ctx
  const spaceId = scope.kind === 'space' ? scope.id : db.world(scope.id).space_id
  for (const step of steps) {
    if (events.signal?.aborted) return
    if ('say' in step) {
      const text = parts.length && parts[parts.length - 1].type === 'tool' ? `\n\n${step.say}` : step.say
      if (pace.instant) {
        parts.push({ type: 'text', text })
        continue
      }
      for (const piece of chunks(text)) {
        if (events.signal?.aborted) return
        parts.push({ type: 'text', text: piece })
        events.onText?.(piece)
        await pace.sleep(14, events.signal)
      }
      await pace.sleep(220, events.signal)
    } else if ('call' in step) {
      await pace.sleep(260, events.signal)
      if (events.signal?.aborted) return
      let result
      try {
        const args = resolveRefs(db, spaceId, step.call.args) as Record<string, unknown>
        result = runTool(db, scope, { tool: step.call.tool, args })
      } catch (e) {
        result = { ok: false, summary: `${step.call.tool} rejected: ${e instanceof Error ? e.message : e}` }
      }
      const part = { type: 'tool' as const, tool: step.call.tool, summary: result.summary, ok: result.ok }
      parts.push(part)
      events.onTool?.(part)
      ctx.onChange()
    } else if ('instruct' in step) {
      await pace.sleep(260, events.signal)
      let worldId: number
      try {
        worldId = resolveRefs(db, spaceId, `@world:${step.instruct}`) as number
      } catch (e) {
        const part = { type: 'tool' as const, tool: 'instruct_world', summary: String(e), ok: false }
        parts.push(part)
        events.onTool?.(part)
        continue
      }
      const part = {
        type: 'tool' as const,
        tool: 'instruct_world',
        summary: `Asked the ${step.instruct} agent: ${step.instruction}`,
        ok: true,
      }
      parts.push(part)
      events.onTool?.(part)
      // The world agent's own turn, recorded in that world's chat.
      const worldScope: ChatScope = { kind: 'world', id: worldId }
      const key = scopeKey(worldScope)
      db.addMessage(key, {
        role: 'user',
        parts: [{ type: 'text', text: step.instruction }],
        stopped: false,
        from_space_agent: true,
      })
      const worldParts: MessagePart[] = []
      // Its tool calls still show up live in the space chat, as sub-steps.
      await play(step.steps, worldScope, worldParts, {
        ...ctx,
        events: {
          signal: events.signal,
          onTool: (p) => {
            const sub = { ...p, summary: `${step.instruct}: ${p.summary}` }
            parts.push(sub)
            events.onTool?.(sub)
          },
        },
        pace: { ...pace, instant: true, sleep: pace.instant ? pace.sleep : (_ms, s) => pace.sleep(240, s) },
      })
      db.addMessage(key, { role: 'assistant', parts: merge(worldParts), stopped: !!events.signal?.aborted })
      ctx.onChange()
    } else {
      let next: Step[]
      try {
        next = step.dynamic(db, scope)
      } catch {
        next = [{ say: 'I could not read this space just now.' }]
      }
      await play(next, scope, parts, ctx)
    }
  }
}
