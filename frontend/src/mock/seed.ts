import { Db, emptyState, type DbState } from './db'
import { answer, instantPace, resolveRefs } from './agents/runner'
import { SCRIPTS, USER_REASONS } from './agents/petstore'

export const SEED_SPACE_TITLE = 'Improving the Swagger Petstore API'

/**
 * The seeded database: the Petstore space, built by playing the headline
 * script instantly (so its space chat shows the conversation), plus a few
 * reasons a person added, and one empty space to watch the agent live.
 */
export async function seedState(now: () => number = Date.now): Promise<DbState> {
  const db = new Db(emptyState(), now)
  const space = db.createSpace(SEED_SPACE_TITLE, 'A PM workspace for the next Petstore API release.')
  const headline = SCRIPTS.find((s) => s.id === 'petstore')!
  await answer(db, { kind: 'space', id: space.id }, headline.label, SCRIPTS, {}, instantPace, () => {})
  for (const [a, b, kind, text] of USER_REASONS)
    db.createReason({
      widget_a: resolveRefs(db, space.id, `@widget:${a}`) as number,
      widget_b: resolveRefs(db, space.id, `@widget:${b}`) as number,
      kind,
      text,
      author: 'user',
    })
  db.createSpace('Try it: an empty space', 'Ask the space agent to set it up and watch it build.')
  return db.state
}
