import type { ConceptChip } from '../api/types'

/**
 * Every concept taught in a node. Home concepts (first taught here) are
 * filled; concepts taught again here, with a verified quote, are outlined.
 */
export function ConceptChips({
  chips,
  titleOf,
  onGoHome,
}: {
  chips: ConceptChip[]
  titleOf: (nodeId: number) => string
  onGoHome: (nodeId: number) => void
}) {
  if (!chips.length) return null
  return (
    <ul className="concept-chips" aria-label="Concepts taught here">
      {chips.map((c) =>
        c.home ? (
          <li key={c.id} className="concept-chip is-home" title="First taught here">
            {c.name}
          </li>
        ) : (
          <li key={c.id} className="concept-chip is-retaught">
            <button
              type="button"
              className="concept-chip-button"
              title={`Taught again here; first taught in “${c.home_canvas_node_id ? titleOf(c.home_canvas_node_id) : '?'}”`}
              onClick={(e) => {
                e.stopPropagation()
                if (c.home_canvas_node_id) onGoHome(c.home_canvas_node_id)
              }}
            >
              <span aria-hidden="true" className="concept-chip-mark">
                ↩
              </span>
              {c.name}
            </button>
          </li>
        ),
      )}
    </ul>
  )
}
