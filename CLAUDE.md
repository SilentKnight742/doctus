# Doctus: project context for Claude Code

Doctus is a learning companion: you chat with a tutor like any good AI
assistant, and a map of what you explored and were taught grows alongside the
chat. Planning happens in claude.ai; building happens here. This is a
user-experience-first project: build, try it, improve. Prefer a working,
pleasant slice over more planning.

## Vision (revised 2026-11-22 after studying mindmap.io)
The canvas UI/UX follows mindmap.io's latest version (a branching tree of
nodes, grown like a rabbit hole). What Doctus adds on top is the evidence-backed
concept layer and much richer per-node visualisation.

- **Exploration canvas, not a roadmap** (think of the Wikipedia game). A subject
  is a branching tree that records where the learner actually went.
- **Canvas nodes** form the tree. Each has at most one parent; the root is the
  origin chat, where learning began.
  - `chat` node: holds its own conversation with the tutor. A follow-up inside
    the node continues that conversation; going somewhere new is a child chat
    node (a new branch).
  - `note` node: the learner's own text (Markdown). No AI.
  - The learner creates the nodes. The tutor may only *suggest* branches (below).
- **Concepts** (the evidence layer; this is Doctus's differentiator). The
  cartographer extracts concepts *taught* in a chat node. Every concept needs at
  least one verbatim evidence quote from that node's conversation, checked in
  code; no quote, no concept. A concept means taught, not learned. A concept
  belongs to the chat node where it was first taught; teaching it again in
  another node adds evidence to the same concept (dedupe by normalised name
  within the subject).
- **Concept links** (directed, typed) between concepts:
  - `prerequisite`: A must be understood before B; the reason must match the
    arrow. No cycles.
  - `related`: adjacent, no direction meaning.
  - Links may cross branches. On the canvas they are drawn between the canvas
    nodes that contain the two concepts. mindmap.io cannot do this because it is
    a strict tree.
- **`part_of` is retired (2026-11-22).** The branch tree is now the visible
  hierarchy. `part_of` is already built: the cartographer stops emitting it and
  the UI ignores it; deleting the code is a later cleanup.
- **Suggestions (revises the 2026-11-15 "no suggestions" decision).** After each
  exchange the cartographer may propose up to 3 short follow-up questions for
  that chat node. They appear as faint chips under the node; clicking one
  creates a child chat node with that question as its first message. A
  suggestion is never a canvas node or a concept until accepted. Frontier nodes
  stay removed.
- **Branch path** replaces the trail in the UI: the chain from the root to a
  node, readable as one continuous document. The existing trail table and
  `/visit` can stay; the UI does not need them.
- **Zoom**: (a) manual collapse of a branch, with a badge counting the hidden
  nodes; (b) text levels by zoom: full card when zoomed in, the node's title at
  mid zoom, one keyword when zoomed out. The cartographer writes the title and
  keyword in the call it already makes (no extra model calls). This replaces
  M2's size-driven `part_of` zoom.
- **"Each node is its own world"**: much richer per-node visualisation is the
  main thing Doctus will add over mindmap.io. Apoorv will define it. Until then,
  keep the node interior simple and leave room for it (the node detail panel).
- **Mastery rule is NOT decided.** Keep `PlaceholderDecayModel` behind the
  `MasteryModel` interface; build nothing that depends on its formula.
- Gamification (later) rewards verified recall, not time or message counts.

## Two AI layers
Every learner message touches two separate layers with separate prompts:
1. **Tutor**: talks with the learner. It never mentions the canvas, nodes,
   concepts or extraction, and it is never told to create graph material. Its
   context is the node's branch (the conversations of its ancestor chat nodes,
   oldest trimmed first to a budget, trimmed nodes represented by their titles)
   plus quiet concept context (concepts already taught, prerequisites of the
   current topic). Sibling branches are excluded.
2. **Cartographer**: reads the latest exchange of a chat node after the tutor
   replies. In one call it outputs: concepts with evidence quotes, concept
   links, the node's title and keyword, and up to 3 suggestions. Existing
   extraction and evidence rules apply.

## Status
- 2026-11-15: backend done: store, LLM layer (Gemini + FakeLLM), evidence-checked
  extraction. Pilots: starter map on German about 80-89% link precision (Claude's
  second-opinion marks); extraction live runs on German (5 covered, 8 quotes
  verified, 0 dropped) and "starter Pokemon of all regions" (9 covered, 11
  verified, 0 dropped). Narrative subjects (a TV episode) produce plot/cause
  links, not learning dependencies: a known limit.
- M0 merged (repo hygiene, `backend/`, CI, README, docs/eval).
- M1 merged (tutor/cartographer split, `part_of` edges, no frontier, 429 with
  Retry-After, 115 backend tests, 5 live scenarios passed).
- **M2 merged (PR #3)**: the first frontend (two-screen layout: chat screen and
  graph screen with a floating chat window, size-driven `part_of` zoom), plus
  `/visit`, the frontend CI job, API client, Markdown chat and `theme.css`
  variables.
- 2026-11-22: design revised after the mindmap.io study (this file). The
  two-screen layout and the `part_of` zoom are superseded by the branch canvas:
  **M3 is the canvas backend, M4 the canvas UI.** Reuse M2's frontend
  scaffolding (build setup, CI, API client, chat and Markdown components, theme
  variables) and replace its screens.
- 2026-11-22: M3 (`feat/branch-canvas`) in review: canvas tree, migration,
  streamed chat with stop, branch context, cartographer title/keyword/
  suggestions, 310 backend tests, one live German session
  (docs/eval/canvas-german-2026-11-22.md). The M2 UI no longer works
  against the backend until M4.
- 2026-11-23: M3 merged (PR #5). M4 split into two PRs (Apoorv's call):
  **M4a** `feat/canvas-ui` (backend tweaks: every concept taught per node with
  a home flag, Gemini 503 as "model busy" with Retry-After; API client and
  SSE; clockwise layout; canvas with cards; chat and streaming) and **M4b**
  (editing, keys, context menu, collapse, zoom levels, concept links, panels,
  search, themes). M4a decisions: slim left rail; indigo accent, provisional
  in `theme.css`; a concept counts as taught again in a node only with a
  verified quote there; cards have a fixed max height with "Open" for the
  full conversation; concept links will be React Flow custom edges; canvas
  shortcuts fire only when no text field is focused; visible states for
  unanswered (Answer) and cartographer failed (Retry via /extract); sibling
  moves animate and the selected node stays in place.
- Known limit: the tutor on `gemini-3.5-flash-lite` makes small factual slips
  (5 in about 16 replies in testing). A stronger tutor model is planned.
- Check git for which milestones are actually merged before starting; do not
  assume.

## Git workflow (same as Videre)
- Never commit or push directly to `main`. One branch per milestone
  (`chore/...`, `feat/...`, `fix/...`, `docs/...`), Conventional Commits
  (`feat(ui): ...`, `fix(graph): ...`).
- Run lint and tests before opening a PR. Open the PR with `gh pr create`,
  then **STOP**: never merge it. Apoorv reviews and merges (squash). Do not start
  the next milestone until he says `main` has been updated (`git pull` first).
- Never force-push and never use `--no-verify`.
- Push over **HTTPS** with Apoorv's saved GitHub login, never SSH. The remote
  must be `https://github.com/SilentKnight742/doctus.git`. Do not accept SSH
  host keys or create SSH keys.
- Commit identity: `Apoorv Chitnis <77118742+SilentKnight742@users.noreply.github.com>`
  (the same as Videre). Set it in this repo's local git config.

## Milestones

### M0-M2: merged
See Status. Their detailed specs are in git history.

### M3 `feat/branch-canvas` (backend for the canvas)
1. **Storage.** Add a `canvas_nodes` table: `id`, `subject_id`, `parent_id`
   (null only for the root), `kind` (`chat` | `note`), `sort_index`, `title`,
   `keyword`, `note_body`, `created_at`. Messages get `canvas_node_id`. Concepts
   (the existing evidence-backed nodes) get `home_canvas_node_id`; evidence keeps
   pointing at message ids. Enforce one parent and no cycles. Dev data only: an
   existing subject becomes a single root chat node holding all its messages.
2. **Endpoints.** Create a child or sibling node (a chat node with its first
   question, or a note); update a note's body; edit a chat node's prompt only
   while it has no answer; delete a node (a branch delete needs a confirm flag);
   rename a subject/map; get the subject canvas (nodes, concept chips per node,
   concept links mapped to node pairs, open suggestions, `graph_version`); get a
   branch path as one document; search (titles, messages, notes, concepts).
3. **Tutor context** per the "Two AI layers" section: the ancestor branch within
   a budget plus quiet concept context; siblings excluded.
4. **Cartographer schema**: concepts + evidence, concept links, node title and
   keyword, up to 3 suggestions, all in one call. Evidence check unchanged.
   Dedupe concepts within a subject. Stop emitting `part_of`.
5. **Suggestions**: accepting one creates a child chat node with that text as
   its first message and removes the suggestion.
6. **Streaming**: stream tutor replies (SSE) with a stop action; a stopped reply
   keeps what was written. The cartographer runs after a full or stopped reply.
7. Tests with FakeLLM: tree integrity (one parent, no cycles); tutor context
   excludes siblings; evidence check per node; concept dedupe across nodes;
   suggestion accept flow; branch path; search; prompt editing blocked after an
   answer; stop keeps the partial reply. Then one live German session that
   branches at least twice; show Apoorv the canvas JSON. Update the README.
   Open the PR and stop.

### M4 `feat/canvas-ui`
React + TypeScript + Vite in `frontend/`, with React Flow for the canvas. Reuse
M2's scaffolding; the two-screen layout (chat screen + graph screen with a
floating chat window) and the size-driven `part_of` zoom are removed.
- **Screens**: the canvas for one subject, plus a subject list (a home view or a
  slim left rail). Maps can be renamed; the browser tab shows the map name.
- **Visual design**: follow mindmap.io's element design closely (node cards,
  connectors, controls, overall restraint) but with Doctus's own, slightly
  different palette (an accent that is not their teal). **Plain background**: no
  grid, dots or hexagon pattern (turn React Flow's `Background` off). Light and
  dark themes. Keep every value in `theme.css`. Show Apoorv screenshots of both
  themes before opening the PR.
- **Node cards**: a chat card shows its prompt and the rendered answer (Markdown,
  clamped with scroll), concept chips, and an input for follow-ups inside the
  node. A note card shows Markdown. The origin is highlighted. New nodes
  briefly highlight.
- **Creating and editing**: arrow keys move the selection; Cmd/Ctrl+arrow adds
  a child or a sibling; Enter edits; Esc leaves. Hovering a node shows + (add)
  and − (collapse). Right-click opens a menu (add, edit, collapse, delete) where
  each entry shows its shortcut. A node can switch between note and chat before
  it is sent. Editing happens in place: other nodes dim, clicking away saves.
  Suggestion chips sit under a chat node.
- **Collapse**: a collapsed branch shows a badge counting the hidden nodes.
- **Layout**: one layout only: branches on both sides of the root, read
  clockwise (down the right, back up the left).
- **Zoom and navigation**: zoom to fit (Shift+1), wheel zoom anchored on the
  cursor, middle-mouse pan, zoom out to 15%. Three text levels by zoom: full
  card, title, keyword.
- **Search**: `/` opens search; matches highlight, everything else dims, and the
  canvas moves to each result.
- **Branch as document**: Space on a node opens the path from the root to it as
  one continuous conversation in a side panel.
- **Concept links**: `prerequisite` solid with an arrow, `related` dashed with
  no arrow, drawn between canvas nodes. Faint by default, emphasised for the
  selected node, with a toggle to hide them.
- **Node detail panel** (selected node): its concepts with evidence quotes and
  links. Leave room here for the "own world" work.
- **Chat UX**: Markdown (headings, lists, tables, code), Enter to send,
  Shift+Enter for a newline, streaming with a stop button and Ctrl+Esc, and
  clear errors (429 means "rate limited, try again in a minute"). A "context
  used" toggle on assistant messages, off by default (a development aid).
- After each message, poll the graph status until the cartographer is idle,
  then refresh.
- The visitor token is kept in `localStorage`, with a fallback when that is
  unavailable. The Vite dev server proxies `/api`. `make dev` starts the
  backend and frontend together.
- Keep the frontend CI job passing; update the Vitest tests (API client, layout)
  and the Playwright screenshots for the README.
- Open the PR and stop.

## Tutor behaviour (prompt guidance)
Write the tutor like a strong general assistant (Claude- or GPT-like) that
happens to be an excellent teacher:
- Answer what was asked, fully and well structured: explanation, examples, a
  table or code where it helps. Length matches the question; no one-liners
  followed by a quiz.
- Do not end every reply with a question. Check understanding only when it is
  natural or when the learner asks to be tested.
- It has a personality: warm, curious, a little wit, and opinions when asked.
  Plain language, no filler, no sycophancy. It follows the learner's lead,
  including tangents, and can suggest where to go next without forcing it.
- It uses the background context only to tailor depth (for example, briefly
  recapping a prerequisite the learner hasn't covered yet), never by mentioning
  graphs, nodes, levels or "context".
- It corrects mistakes clearly and kindly, and says when it is unsure.

## Parked from the mindmap.io study (decided 2026-11-22; do not build now)
- **Later**: drag to reorder siblings; tree and top-down layouts; eight pastel
  node colours; subject-level tutor settings (their map system prompt); web
  search with citations; images and PDFs on nodes; publish / clone / embed a
  public read-only map (high priority later: a strong portfolio demo); touch
  and phone support.
- **Skipped**: AI auto-expand (it breaks the rule that the map records where the
  learner went and what was taught); Milo-style map-editing agent; per-node
  model choice; MCP server and public API; idle tips.

## Other ideas parked for later (do not build now)
- Learner feedback raised GraphQL; REST is fine for a single client, so revisit
  only if the API grows.
- Ideas from Claude's memory architecture for long-term, per-subject context
  management.
- Tests and revision, the mastery rule, gamification, the optional starter-map
  ("show me the territory") view, narrative subjects, import from other
  platforms, deployment, removing the retired `part_of` code.

## Conventions
- Gemini model: `gemini-3.5-flash-lite` (free tier; confirmed working).
  Override with `DOCTUS_GEMINI_MODEL`; the cartographer can use
  `DOCTUS_GRAPH_MODEL`.
- Run tests as `python -m pytest` with the venv active (`pytest` alone picks up
  Kali's system pytest), or `make test`. Never "fix" that by changing code or
  deleting tests.
- Default tests use `FakeLLM`; only `-m live` tests call Gemini. Space out live
  calls (free tier).
- Secrets live only in `.env` (git-ignored); `.env.example` documents them.
  Never print the key or ask for it in chat.
- All model calls go through `doctus.llm.LLM`; structured output is validated
  with Pydantic and retried once.
- Time-boxed: cut scope rather than extend. Ask Apoorv before adding anything
  not listed here.
