# Doctus: project context for Claude Code

Doctus is a learning companion built around a dependency-aware concept graph.
Planning happens in claude.ai; building happens here.

## Vision (agreed)
- Two components: **chat** and **graph**. Chats read context from the graph;
  the graph grows from chats.
- Pages: Home (subjects) -> Subject (subject chat + open graph) -> Graph
  (bird's-eye map) -> Topic (chat scoped to one concept + its prerequisites).
- Keep the **map** (permanent "depends on" edges) separate from the **trail**
  (the order the learner actually visited things). Never mix the two edge types.
- The model **proposes** nodes/edges; the learner accepts or rejects. The model
  never edits the graph directly.
- Gamification rewards verified recall, not time spent or messages sent.

## v1 slice
Home, one subject, graph view, topic chat, basic test that changes a concept's
level, decay visible over time, "review these prerequisites first" lookback.
Out of v1: web search, URL/platform import, practical exercises, goal presets,
trail graph, accounts.

## Status
- Day 1 (done): backend - SQLite store, visitor scoping, cycle checks, LLM layer
  (Gemini + FakeLLM), skeleton/update proposals with filtering, topic chat with
  `context_used`, swappable mastery module. 35 tests pass.
- Day 2 (next): frontend - React + Vite, React Flow for the graph; Home,
  Subject, Graph, Topic pages; accept/reject UI.
- Day 3: tests flow, lookback, decay display, deployment, README screenshots.

## Open decisions
- **Mastery rule is NOT decided.** `PlaceholderDecayModel` is temporary. Do not
  build features that depend on its exact formula; go through `MasteryModel`.
- Test formats beyond short answer (practical exercises) - later.
- Deployment: seeded read-only demo + bring-your-own-key (proposed, not final).

## Conventions
- Gemini model: `gemini-3.5-flash-lite` (free tier; confirmed working).
  Override with `DOCTUS_GEMINI_MODEL`.
- All model calls go through `doctus.llm.LLM`; structured output is validated
  with Pydantic and retried once.
- Tests use `FakeLLM` and never call a real API. Run `pytest` before committing.
- Offline dev: `DOCTUS_LLM=fake uvicorn doctus.main:app --reload`.
- Time-boxed: v1 must ship in ~3 days; cut scope rather than extend.
