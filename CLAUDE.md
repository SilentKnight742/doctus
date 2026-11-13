# Doctus: project context for Claude Code

Doctus is a learning companion that grows a concept graph **from what the learner actually covers in conversation**. Planning happens in claude.ai; building happens here.

## Vision (agreed 2026-11-13)

Doctus is an **exploration graph, not a roadmap**. Think of the Wikipedia game: the graph records where the learner actually went, plus faded suggestions of where they could go next.

- **Origin.** A new subject starts with a chat. Its first node (the origin) is where learning began. 

- **Covered nodes.** Concepts the learner actually learned in a dialogue. Each one carries evidence: a verbatim quote from the chat, checked in code. Covered nodes are added automatically because they are grounded. 

- **Frontier nodes.** Adjacent or prerequisite concepts the dialogue touched on but did not explore. Shown faded, as suggestions. The learner can open one (starting its own topic chat) or dismiss it. 

- **Recursion.** Opening a frontier node starts its topic chat; once learned there it becomes covered and gains its own frontier. Further from the origin, overlap with the starting point decreases. 

- **Edge kinds.** `prerequisite` (A must be understood before B) and `related` (adjacent). Separately, the **trail** records the order the learner visited nodes. Never mix trail steps with graph edges. 

- **Chat and graph.** Topic chats read context from the graph; the graph grows from topic chats. 

- **Gamification** rewards verified recall, not time spent or messages sent. 

- **Mastery rule is NOT decided.** `PlaceholderDecayModel` is temporary; always go through the `MasteryModel` interface. 

## Status

- **Done:** backend v0.1 (store, visitor scoping, cycle checks, LLM layer with Gemini + FakeLLM, topic chat with `context_used`, swappable mastery), `.env` setup, live Gemini test, starter-map pilot (German about 80-89% link precision; narrative subjects such as a TV episode produce cause/plot links, not learning dependencies: a known limit). 

- **If the v0.1 code is not pushed yet, push it before starting the redesign.** 

- **Next: Task 1 below** (backend redesign). Then the frontend, then tests and revision. 

## Task 1: exploration-graph backend

Implement on the existing code. Keep the store, LLM layer, context builder and mastery module. The starter-map `skeleton` endpoint and the `proposals` table stay in the code but leave the main flow (later: optional "show me the territory" view).

### Data model

- `nodes`: add `status` (`covered` | `frontier` | `dismissed`), `covered_at`, and `last_extracted_message_id`. 

- `subjects`: add `origin_node_id`. 

- New `node_evidence` (node\_id, message\_id, quote). The quote must be a verbatim substring of that message (compare after normalising whitespace and case). Evidence that fails the check is dropped. 

- `edges`: add `kind` (`prerequisite` | `related`). The cycle check applies only to `prerequisite` edges. Store edges as (from, to, kind, reason). 

- New `trail` (subject\_id, node\_id, from\_node\_id nullable, at). Record a step when the learner sends the first message in a node's chat in a session, with `from_node_id` supplied by the client. 

### Flows

1. **New subject.** `POST /api/subjects {title, goal}` creates the subject and an origin node named after the title, with status `frontier` until covered. The learner's first chat happens in the origin node's topic chat. 

2. **Extraction trigger.** After every 3rd learner message in a topic chat since that node's last extraction, run extraction automatically. Also expose `POST /api/nodes/{id}/extract`. Only messages after `last_extracted_message_id` are sent (plus the 2 messages before them for context). Free-tier limits are low: one extraction call per trigger, no retries beyond the existing one-retry-on-invalid-JSON. 

3. **Extraction output** (Pydantic schema, validated): 

   - `covered`: concepts the dialogue actually taught; each has name, summary, 1-2 `evidence` quotes copied verbatim from the conversation, and its link to the current node (`kind`, direction, reason). 

   - `frontier`: concepts mentioned or clearly needed but not explored; each has name, summary, the node it attaches to, `kind`, direction and reason. 

   - Prompt rules: one node per teachable idea; reuse existing names when they mean the same thing; for every prerequisite edge the reason must explain why the prerequisite must come first, and the arrow must match the reason (the pilot found a case where the reason contradicted the arrow). 

4. **Applying extraction** (deterministic code, unit-tested): 

   - Covered concept with at least one verified quote: create it as `covered`, or promote an existing `frontier` node to `covered`. Without a verified quote: drop it and count the drop. 

   - If the current node's own concept is evidenced, mark it `covered`. 

   - Frontier: at most 3 new frontier nodes per attach point per extraction; skip names that already exist (any status, including `dismissed`, so dismissed suggestions never come back). 

   - Edges: skip duplicates, self-links, and prerequisite cycles. 

   - Return a summary: added, promoted, dropped (with reason), skipped. 

5. **Dismiss.** `POST /api/nodes/{id}/dismiss` sets a frontier node to `dismissed` (not allowed for covered nodes or the origin). 

6. **Graph API.** `GET /api/subjects/{id}/graph` returns nodes (status, strength, level, distance from origin computed by BFS over edges ignoring direction), edges with kind, the trail, and extraction stats (covered nodes, evidence verified vs dropped). 

7. **Topic chat context.** Add covered neighbours and the names of the node's frontier suggestions to the context builder, and keep `context_used` in sync. 

### Tests (FakeLLM only)

Evidence verification (exact, whitespace or case differences, fabricated quote); frontier promoted to covered; frontier cap of 3; dismissed names not re-suggested; extraction triggers on the 3rd message and not before; `last_extracted_message_id` advances; cycle check applies to prerequisite edges only; distance from origin; trail records `from_node_id`; another visitor cannot extract, dismiss or read.

### Done when

All tests pass with `python -m pytest`; one live run (`-m live` or curl) shows a real chat of 6 messages producing grounded covered nodes and a few frontier nodes. Show Apoorv the result, including any dropped evidence, before committing. Push only when he says so.

## Later (not now)

Frontend (React + Vite, React Flow, layout outward from the origin); tests and revision; optional starter-map view; narrative subjects; deployment.

## Conventions

- Gemini model: `gemini-3.5-flash-lite` (free tier; confirmed working). Override with `DOCTUS_GEMINI_MODEL`. 

- Run tests as `python -m pytest` with the venv active (`pytest` alone picks up Kali's system pytest). Never "fix" that by changing code or deleting tests. 

- Default tests use `FakeLLM` and never call a real API; only `-m live` tests do. 

- Secrets live only in `.env` (git-ignored); `.env.example` documents them. Never print the key or ask for it in chat. 

- All model calls go through `doctus.llm.LLM`; structured output is validated with Pydantic and retried once. 

- Offline dev: `DOCTUS_LLM=fake uvicorn doctus.main:app --reload`. 

- Git: push over **HTTPS** using Apoorv's saved GitHub login, never SSH. The remote must be `https://github.com/SilentKnight742/doctus.git`; if `git remote -v` shows an SSH URL, fix it with `git remote set-url origin` to that address. Do not accept SSH host keys or create SSH keys. Push only when Apoorv says so. 

- Time-boxed: cut scope rather than extend. Ask Apoorv before adding anything not listed here. 

