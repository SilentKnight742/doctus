import type { Brief, ContextUsed as Ctx } from '../api/types'

function names(list: Brief[] | undefined) {
  return list && list.length ? list.map((b) => b.name).join(', ') : '—'
}

/** Development aid: what background the tutor was given for a reply. */
export function ContextUsed({ ctx }: { ctx: Ctx }) {
  return (
    <dl className="context-used">
      <dt>Topic</dt>
      <dd>{ctx.node?.name ?? '—'}</dd>
      <dt>Prerequisites</dt>
      <dd>{names(ctx.prerequisites)}</dd>
      <dt>Part of</dt>
      <dd>{ctx.part_of?.name ?? '—'}</dd>
      <dt>Parts</dt>
      <dd>{names(ctx.parts)}</dd>
      <dt>Nearby</dt>
      <dd>{names(ctx.nearby)}</dd>
      {ctx.recent_turns !== undefined && (
        <>
          <dt>Recent turns</dt>
          <dd>{ctx.recent_turns}</dd>
        </>
      )}
    </dl>
  )
}
