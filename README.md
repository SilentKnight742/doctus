# Doctus

*Latin: "one who teaches."*

Doctus is a learning companion. You chat with a tutor as you would with any
good AI assistant, and a concept graph of what the chat actually covered grows
alongside it.

> **Status:** backend only, under active redesign. There is no frontend yet;
> try it through the API docs at `/docs`. See
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

Implemented (on `main`):

- SQLite store with anonymous visitor scoping (`X-Doctus-Visitor` header).
- LLM layer: Gemini and a deterministic `FakeLLM`; structured output is
  validated with Pydantic and retried once.
- Origin node per subject; topic chat per node with a `context_used` record.
- Extraction with verified evidence quotes, a trail with `from_node_id`, and
  distance from the origin.
- Edge kinds `prerequisite` and `related`, with cycle checks on
  `prerequisite`.
- The origin chat answers the whole question in its first reply and builds
  the graph from it.
- 64 offline tests; one opt-in live Gemini test.

In progress (M1, tutor and cartographer):

- Separate tutor and cartographer layers; the cartographer runs after every
  exchange in the background (today extraction runs inline, after the
  origin's first reply and then every 3rd learner message).
- `part_of` edges and traversal helpers (ancestors, descendants, path).
- Removing frontier (suggestion) nodes. The current code still creates
  frontier nodes and has a `/dismiss` endpoint; both go away in M1.
- A rewritten tutor prompt.

Planned (M2, UI): React + Vite frontend with a chat screen, a graph screen
with semantic zoom, and a live mini graph.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and GNU Make.

```bash
cp backend/.env.example backend/.env   # then add GEMINI_API_KEY
make dev                               # http://127.0.0.1:8000/docs
```

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
| `DOCTUS_DB` | `doctus.db` | SQLite file (relative to `backend/`) |
| `DOCTUS_MAX_PROPOSALS` | `5` | Max proposals per update (starter-map flow) |
| `DOCTUS_RECENT_TURNS` | `8` | Chat turns sent to the tutor |

Real environment variables win over `backend/.env`.

## Tests and lint

```bash
make test   # offline; uses FakeLLM, no API key needed
make lint   # ruff check and ruff format --check
make fmt    # apply ruff fixes and formatting
```

The opt-in live test makes one real chat call and one structured call:

```bash
cd backend && uv run python -m pytest -m live
```

## API (current)

```
GET  /api/subjects                       list your subjects
POST /api/subjects                       {title, goal} -> subject + origin node
GET  /api/subjects/{id}/graph            nodes, edges (with kind), trail, extraction stats
GET  /api/nodes/{id}                     node, evidence, edges, context, chat history
POST /api/nodes/{id}/chat                {message, from_node_id?} -> reply, context_used, extraction
POST /api/nodes/{id}/extract             run extraction on new messages now
POST /api/nodes/{id}/dismiss             dismiss a frontier node (removed in M1)

# Older starter-map flow, outside the main flow:
POST /api/subjects/{id}/skeleton         propose a starter map
GET  /api/subjects/{id}/proposals        pending proposals
POST /api/proposals/{id}/accept|reject
POST /api/nodes/{id}/update-graph        propose changes from the recent chat
```

## Layout

```
backend/
  src/doctus/
    api.py         HTTP endpoints
    store.py       SQLite storage, visitor scoping, cycle checks, trail, evidence
    extraction.py  model output -> evidence-checked graph changes
    graph.py       distance from origin; older proposal flow
    context.py     topic-chat context and the "context used" record
    mastery.py     swappable mastery model (placeholder rule)
    prompts.py     prompts and structured-output schemas
    llm/           provider interface, Gemini, fake model for tests
  tests/
docs/eval/         small pilot results (not benchmarks)
```

## Current limits

- No frontend.
- Duplicate detection is by normalised name only; near-synonyms can become
  separate nodes.
- The evidence check proves a quote is in the chat, not that the concept was
  taught well; the model still chooses which concepts to record.
- Narrative subjects (for example a TV episode) produce plot or cause links
  rather than learning dependencies.
- Tests and mastery updates are not wired to endpoints yet.
- Single process, SQLite, no accounts (anonymous visitor tokens).
- Free-tier Gemini rate limits are low; a burst of messages can return 429.

## Pilot results

Small pilots, run by hand with one learner judging, are in
[docs/eval/](docs/eval/). They are not benchmarks.

## License

To be decided.
