# Doctus

*Latin: "one who teaches."*

Doctus is a learning companion built around a **dependency-aware concept
graph**. You study a subject by chatting about one concept at a time. Each
chat is given that concept's prerequisites as context. As you learn, Doctus
proposes new concepts and prerequisite links, and you approve them, so the
map grows with you and stays trustworthy.

> **Status:** early v1, backend only. The frontend comes next.

## How it works

```
Subject ──► starter map (proposed by the model, approved by you)
   │
   └─► Concept ──► topic chat (context = concept + prerequisites + recent turns)
                      │
                      └─► "Update graph" ──► proposals ──► you accept / reject
```

- **The model never edits the graph directly.** It proposes changes. They are
  filtered (duplicates, self-links, unknown names, cycles) and you approve
  each one. The acceptance rate is tracked per subject.
- **Every reply shows its context.** The chat endpoint returns exactly which
  concept, prerequisites and how many recent turns the model was given.
- **Mastery is a swappable module.** The rule for how strength grows and fades
  is not final. Everything goes through the `MasteryModel` interface; the
  current `PlaceholderDecayModel` is a provisional stand-in.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Offline, no API key (canned model answers):
DOCTUS_LLM=fake uvicorn doctus.main:app --reload

# With Gemini:
export GEMINI_API_KEY=...            # from Google AI Studio
uvicorn doctus.main:app --reload
```

API docs: http://127.0.0.1:8000/docs. Every request needs an
`X-Doctus-Visitor` header (any random string of 16+ characters).

| Variable | Default | Purpose |
|---|---|---|
| `DOCTUS_LLM` | `gemini` | `gemini` or `fake` |
| `GEMINI_API_KEY` | none | Gemini API key |
| `DOCTUS_GEMINI_MODEL` | `gemini-3.5-flash-lite` | Any Gemini model your key can use |
| `DOCTUS_DB` | `doctus.db` | SQLite file |
| `DOCTUS_MAX_PROPOSALS` | `5` | Max proposals per graph update |
| `DOCTUS_RECENT_TURNS` | `8` | Chat turns kept in context |

## Tests

```bash
pytest
```

Tests use a deterministic fake model, so they need no API key.

## API

```
GET  /api/subjects                       list your subjects
POST /api/subjects                       {title, goal}
GET  /api/subjects/{id}/graph            nodes (with strength, level), edges, proposal stats
POST /api/subjects/{id}/skeleton         propose a starter map
GET  /api/subjects/{id}/proposals        pending proposals
POST /api/proposals/{id}/accept|reject
GET  /api/nodes/{id}                     concept, context, chat history
POST /api/nodes/{id}/chat                {message} -> reply + context_used
POST /api/nodes/{id}/update-graph        propose changes from the recent chat
```

## Layout

```
src/doctus/
  api.py        HTTP endpoints
  store.py      SQLite storage, visitor scoping, cycle checks
  graph.py      model output -> filtered proposals
  context.py    builds topic-chat context and the "context used" record
  mastery.py    swappable mastery model (placeholder rule for now)
  prompts.py    prompts and structured-output schemas
  llm/          provider interface, Gemini, and a fake model for tests
```

## Limits (current)

- No frontend yet; use `/docs` to try it.
- Duplicate detection is by normalised name only (no semantic matching yet).
- Tests and mastery updates are not wired to endpoints yet.
- Single process, SQLite; no login (anonymous visitor tokens).

## License

To be decided.
