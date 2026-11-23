import type { ContextUsed as Ctx } from '../api/types'

function list(items: { title?: string; name?: string }[] | undefined) {
  return items && items.length ? items.map((b) => b.title || b.name || 'untitled').join(' → ') : '—'
}

/** Development aid: what background the tutor was given for a reply. */
export function ContextUsed({ ctx }: { ctx: Ctx }) {
  return (
    <dl className="context-used">
      <dt>Branch</dt>
      <dd>{list(ctx.branch)}</dd>
      <dt>Trimmed</dt>
      <dd>{list(ctx.trimmed_nodes)}</dd>
      <dt>Concepts</dt>
      <dd>{ctx.concepts?.map((c) => c.name).join(', ') || '—'}</dd>
      <dt>Prerequisites</dt>
      <dd>{ctx.prerequisites?.map((c) => c.name).join(', ') || '—'}</dd>
      <dt>History</dt>
      <dd>
        {ctx.history_messages ?? '—'} messages
        {ctx.budget_chars ? `, budget ${ctx.budget_chars} chars` : ''}
      </dd>
    </dl>
  )
}
