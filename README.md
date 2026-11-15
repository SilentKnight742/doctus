# Doctus

*Latin: "one who teaches."*

Doctus is a learning companion. You chat with a tutor as you would with any
good AI assistant, and a concept graph of what the chat actually covered grows
alongside it.

> **Status:** backend done; the web UI (M2) is in progress. See
> [Implemented vs in progress](#implemented-vs-in-progress).

## Design

- **Exploration graph, not a roadmap.** The graph records where the learner
  actually went, like the trail of a Wikipedia game. It does not lay out a
  syllabus in advance.
- **Flat graph.** One kind of node and typed, directed edges. Nothing is
  nested and there are no sub-nodes: every node has its own id
  (`/api/nodes/{id}`) and its connections live in the edges table. Any
  hierarchy is a view computed from edges.
- **Origin.** A subject starts with a chat. Its first node, the origin, is
  where learning began.
- **Evidence check.** A node means "taught in the chat", not "learned". Every
  node except the origin needs at least one quote copied from the
  conversation. Code checks each quote against the stored messages (ignoring
  case, whitespace and markdown emphasis); a concept with no verified quote is
  not created, and the drop is counted.
- **Typed edges.**
  - `prerequisite`: A must be understood before B. The model must give a
    reason that matches the arrow.
  - `part_of`: A is a part of B (a region is part of "starter Pokemon"). At
    most one `part_of` parent per node.
  - `related`: adjacent, no direction meaning.
  - No cycles in `prerequisite` or in `part_of`.
- **Trail.** The order the learner visited nodes is stored separately and is
  never mixed with edges.
- **Semantic zoom (UI).** Zoomed out, nodes collapse into their `part_of`
  ancestors so you see high-level topics; zooming in expands them. Computed
  from `part_of` edges at render time, not stored.
- **Two AI layers** with separate prompts:
  1. **Tutor**: talks with the learner. It never mentions the graph and is
     never asked to produce graph material.
  2. **Cartographer**: reads the latest exchange after the tutor replies and
     updates the graph under the evidence and edge rules above.
- **Mastery is not decided.** Strength and decay go through a swappable
  `MasteryModel` interface; the current `PlaceholderDecayModel` is a stand-in.

## Implemented vs in progress

Implemented:

- SQLite store (WAL) with anonymous visitor scoping (`X-Doctus-Visitor`
  header).
- LLM layer: Gemini and a deterministic `FakeLLM`; structured output is
  validated with Pydantic and retried once.
- **Tutor** and **cartographer** as separate layers with separate prompts.
  The cartographer can use its own model (`DOCTUS_GRAPH_MODEL`).
- The cartographer runs after every exchange, in the background, so the
  reply is never delayed. Runs are serialised per subject; messages that
  arrive during a run get one more run right after it. A failed run (for
  example a 429) is not retried: the next exchange catches up. Clients poll
  `graph_version` and `cartographer: idle | running | error`.
- Evidence check on every node except the origin; no suggestion or
  frontier nodes.
- Edge kinds `prerequisite`, `part_of` and `related`; one `part_of` parent
  per node; cycle checks per directed kind.
- Traversal helpers: `ancestors` and `descendants` by kind, `part_of_root`,
  and the shortest `path` between two nodes.
- Trail with `from_node_id`; distance from the origin.
- 115 offline tests; one opt-in live Gemini test.

In progress (M2, UI, `frontend/`): React + TypeScript + Vite, React Flow.

- Subject list and a "start a subject" form.
- Chat screen: markdown replies (tables, code), Enter to send and
  Shift+Enter for a new line, a pending indicator, clear errors (429 shows
  "rate limited, try again in N s"), a trail breadcrumb, a node detail
  drawer (summary, evidence quotes, connections) and a live mini graph.
- Graph screen: the full graph; selecting a node opens its chat in a
  floating window (minimise, close, expand to the chat screen).
- Semantic zoom: below zoom 0.55 only `part_of` roots are shown, from 0.55
  to 1.0 depth 0-1, above 1.0 everything (with a small margin so it does
  not flicker). Folded nodes show a "+N" count; edges between folded groups
  are merged with a count; edges inside a group are hidden.
- Layout: radial seed (origin at the centre, `part_of` children around
  their parent, other topics on rings by distance) relaxed by a short,
  deterministic spring pass. Positions are kept as the graph grows; "Tidy
  layout" recomputes them.
- After each message the UI polls `/graph/status` until the cartographer is
  idle, then refreshes the graph; new nodes briefly highlight.
- "Context used" toggle on replies received in the current session.
- Light and dark themes with neutral placeholder styling. The visual design
  is not decided: every colour, font, size, radius and spacing value is a
  CSS variable in `frontend/src/theme.css`.

## Run it

Needs [uv](https://docs.astral.sh/uv/), Node 24 with npm, and GNU Make.

```bash
cp backend/.env.example backend/.env   # then add GEMINI_API_KEY
make dev                               # UI at http://localhost:5173, API docs at :8000/docs
```

`make dev` starts the backend and the Vite dev server together (Vite
proxies `/api`); Ctrl-C stops both. The browser keeps its anonymous visitor
token in `localStorage` (in memory when storage is unavailable).

Offline, with canned model answers and no key:

```bash
cd backend && DOCTUS_LLM=fake uv run uvicorn doctus.main:app --reload
```

Every request needs an `X-Doctus-Visitor` header (any string of 16+
characters).

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | empty | Gemini API key |
| `DOCTUS_LLM` | `gemini` | `gemini` or `fake` |
| `DOCTUS_GEMINI_MODEL` | `gemini-3.5-flash-lite` | Any Gemini model your key can use |
| `DOCTUS_GRAPH_MODEL` | empty (= chat model) | Model for the cartographer |
| `DOCTUS_DB` | `doctus.db` | SQLite file (relative to `backend/`) |
| `DOCTUS_MAX_PROPOSALS` | `5` | Max proposals per update (starter-map flow) |
| `DOCTUS_RECENT_TURNS` | `8` | Chat turns sent to the tutor |

Real environment variables win over `backend/.env`.

## Tests and lint

```bash
make test   # backend (FakeLLM, no API key) and frontend (Vitest) tests
make lint   # ruff check, ruff format --check, oxlint, tsc
make build  # production build of the frontend
make fmt    # apply ruff fixes and formatting (backend)
```

The opt-in live test makes one real chat call and one structured call:

```bash
cd backend && uv run python -m pytest -m live
```

## API

```
GET  /api/subjects                       list your subjects
POST /api/subjects                       {title, goal} -> subject + origin node
GET  /api/subjects/{id}/graph            nodes, edges (with kind), trail, graph_version,
                                         cartographer state, run stats
GET  /api/subjects/{id}/graph/status     {graph_version, cartographer, error} (poll this)
GET  /api/nodes/{id}                     node, evidence, edges, context, chat history
POST /api/nodes/{id}/chat                {message, from_node_id?} -> reply, context_used,
                                         graph_version, cartographer
POST /api/nodes/{id}/extract             run the cartographer now (409 while one is running)

# Older starter-map flow, outside the main flow:
POST /api/subjects/{id}/skeleton         propose a starter map
GET  /api/subjects/{id}/proposals        pending proposals
POST /api/proposals/{id}/accept|reject
POST /api/nodes/{id}/update-graph        propose changes from the recent chat
```

A chat reply comes back before the cartographer has run. To see the new
graph, poll `/graph/status` until `cartographer` is `idle` (or `error`),
then fetch `/graph`.

## Layout

```
backend/
  src/doctus/
    api.py           HTTP endpoints
    tutor.py         the tutor layer: prompt and chat call
    cartographer.py  the cartographer layer: evidence-checked graph changes,
                     background runs
    store.py         SQLite storage, visitor scoping, edge rules, traversal
    graph.py         distance from origin; older proposal flow
    context.py       the tutor's private notes and the "context used" record
    mastery.py       swappable mastery model (placeholder rule)
    prompts.py       prompts and structured-output schemas
    llm/             provider interface, Gemini, fake model for tests
  tests/
frontend/
  src/
    api/             typed client (visitor header, 429 + Retry-After)
    graph/           layout, semantic zoom, React Flow canvas
    chat/            thread, composer, markdown, node detail
    screens/         home, chat screen, graph screen
    shell/           app shell, chat window, breadcrumb
    state/           per-subject state: graph, polling, positions
    theme.css        all design tokens (placeholder, neutral)
docs/eval/         small pilot results (not benchmarks)
```

## Current limits

- The UI has no visual design yet (neutral placeholder theme).
- Duplicate detection is by normalised name only; near-synonyms can become
  separate nodes.
- The evidence check proves a quote is in the chat, not that the concept was
  taught well; the model still chooses which concepts to record.
- The tutor on `gemini-3.5-flash-lite` makes small factual slips (5 in about
  16 replies in testing). The evidence check proves a quote is in the chat,
  not that what it says is correct. A stronger tutor model is planned.
- Narrative subjects (for example a TV episode) produce plot or cause links
  rather than learning dependencies.
- Tests and mastery updates are not wired to endpoints yet.
- Single process, SQLite, no accounts (anonymous visitor tokens).
- Free-tier Gemini rate limits are low. Each exchange is two calls (tutor
  and cartographer), so a burst of messages can return 429.
- Cartographer runs are coordinated in process memory; running several
  server processes against one database is not supported.

## Pilot results

Small hand-run pilots are in
[docs/eval/](docs/eval/). They are not benchmarks.

## License

To be decided.
