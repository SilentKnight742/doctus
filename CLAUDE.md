# Doctus: project context for Claude Code

Doctus is a learning companion: you chat with a tutor like any good AI
assistant, and a concept graph of what you covered grows alongside the chat.
Planning happens in claude.ai; building happens here. This is a
user-experience-first project: build, try it, improve. Prefer a working,
pleasant slice over more planning.

## Vision
- **Exploration graph, not a roadmap** (think of the Wikipedia game). It records
  only where the learner actually went. There are no suggestion or frontier
  nodes (decided 2026-11-15).
- **Flat graph.** One kind of node and typed edges, nothing nested, no sub-nodes.
  Any hierarchy is a *view* computed from edges, never a storage structure.
- **Origin**: a subject starts with a chat; its first node is where learning
  began.
- **Nodes** are concepts *taught in the chat*. Every node except the origin needs
  at least one verbatim evidence quote, checked in code; without one, it is not
  created. A node means taught, not learned; "learned" will come later from tests
  and mastery.
- **Edges** (directed, typed):
  - `prerequisite`: A must be understood before B.
  - `part_of`: A is a part of B (for example, a region is part of "starter
    Pokemon"). A node has at most one `part_of` parent.
  - `related`: adjacent, no direction meaning.
  - No cycles in `prerequisite` or in `part_of`.
- The **trail** (visit order) is separate and never mixed with edges.
- **Semantic zoom (UI only).** Zoomed out, nodes collapse into their `part_of`
  ancestors so you see high-level topics; zooming in expands them into detail.
  Computed from `part_of` edges at render time.
- **Mastery rule is NOT decided.** Keep `PlaceholderDecayModel` behind the
  `MasteryModel` interface; build nothing that depends on its formula.
- Gamification (later) rewards verified recall, not time or message counts.

## Two AI layers
Every learner message touches two separate layers with separate prompts:
1. **Tutor**: talks with the learner. It never mentions the graph, nodes or
   extraction, and it is never told to create graph material.
2. **Cartographer**: reads the latest exchange after the tutor replies and
   updates the graph (nodes and typed edges) using the existing extraction and
   evidence rules. The graph should come naturally from ordinary
   conversation, not from forcing a question-and-answer format.

## Status (2026-11-15)
- M0 (`chore/repo-hygiene`) merged: noreply history (force-pushed once; no
  more force-pushes), backend in `backend/` (uv + lockfile, ruff,
  `make dev|test|lint|fmt`), CI on Python 3.11, README, pilots in `docs/eval/`.
- M1 (`feat/tutor-and-cartographer`) merged: tutor and cartographer split
  (cartographer runs in the background after every exchange, `graph_version`
  + `cartographer: idle | running | error`), `part_of` edges with one parent
  and per-kind cycle checks, frontier removed, traversal helpers, 429 with
  `Retry-After`. 115 offline tests pass; 5 live scenarios passed.
- Local dev: `backend/.env` and `backend/doctus.db` (both git-ignored).
  `make test` uses `uv run python -m pytest` in `backend/.venv`, which avoids
  Kali's system pytest.
- Pilots: starter map on German about 80-89% link precision; extraction live
  runs on German (5 covered, 8 quotes verified, 0 dropped) and "starter Pokemon
  of all regions" (9 covered, 11 verified, 0 dropped). Narrative subjects (a TV
  episode) produce plot/cause links, not learning dependencies: a known limit.
- Known limit: the tutor on `gemini-3.5-flash-lite` makes small factual slips
  (5 in about 16 replies in testing). The evidence check proves a quote is in
  the chat, not that it is correct. A stronger tutor model is planned.
- M2 (`feat/ui`, PR open): React + Vite UI with chat and graph screens,
  floating chat window, mini graph, trail breadcrumb (`POST /visit` records
  a step when a chat opens), size-driven semantic zoom (S(d) = S0 * r^d,
  merge below MIN on screen, split above MIN * 1.15, origin's direct parts
  never merge, min zoom MIN / S0), neutral placeholder theme with every
  design value in `frontend/src/theme.css`. 118 backend + 24 frontend tests.
  Live check: 6-exchange Gemini session, 18 nodes, 26 quotes verified,
  1 dropped, no 429s. Screenshots in `docs/screenshots/m2/`
  (`frontend/scripts/screenshots.mjs`).
- Open question for review: with MIN = 48 px, labels are about 5 px at the
  minimum zoom (MIN limits the box, not the text). Options: raise MIN to
  about 110 px or keep a minimum on-screen label size.

## Git workflow (same as Videre)
- Never commit or push directly to `main`. One branch per milestone
  (`chore/...`, `feat/...`, `fix/...`), Conventional Commits
  (`feat(ui): ...`, `fix(graph): ...`).
- Run lint and tests before opening a PR. Open the PR with `gh pr create`,
  then **STOP**: never merge it. Apoorv reviews and merges. Do not start the next
  milestone until he says `main` has been updated (`git pull` first).
- Never force-push and never use `--no-verify`, except the single exception
  in M0 step 1.
- Push over **HTTPS** with Apoorv's saved GitHub login, never SSH. The remote
  must be `https://github.com/SilentKnight742/doctus.git`. Do not accept SSH
  host keys or create SSH keys.
- Commit identity: `Apoorv Chitnis <77118742+SilentKnight742@users.noreply.github.com>`
  (the same as Videre). Set it in this repo's local git config.

## Milestones

### M0 `chore/repo-hygiene`
1. **One-time history fix (needs Apoorv's explicit OK before running).** All
   existing commits have the author email `you@example.com`. Rewrite every
   commit's author and committer to the identity above, verify with
   `git log --format='%an <%ae>'`, then force-push `main` once with
   `--force-with-lease`. Do this before creating any branch. This is the only
   permitted force-push.
2. Restructure like Videre: move the Python package to `backend/` (its own
   `pyproject.toml`, `src/`, `tests/`, `.env.example`), and leave room for
   `frontend/`. Add a root `Makefile` (`make dev`, `make test`, `make lint`)
   and set up `ruff` (check and format) for the backend.
3. Add `.github/workflows/ci.yml` running backend lint and tests on push to
   `main` and on PRs (Python 3.11 or later; skip live tests). The frontend job
   is added in M2.
4. Rewrite `README.md` for the design in this file's Vision (flat graph,
   evidence check, typed edges, semantic zoom, the two AI layers): what it is,
   how to run it, current limits, and a short "implemented vs in progress" list.
   No marketing language. M1 and M2 each update the README for what they change.
5. Save the pilot results to `docs/eval/` (starter-map pilot, the German
   extraction reruns, the Pokemon run), with numbers taken from the commit
   messages and any saved raw output. Mark them as a small pilot, not a
   benchmark.
6. Update this file's Status section. Open the PR and stop.

### M1 `feat/tutor-and-cartographer`
1. Split the layers: `tutor` (prompt plus chat call) and `cartographer` (the
   existing extraction, triggered differently). Separate prompt constants and an
   optional separate model setting (`DOCTUS_GRAPH_MODEL`, defaulting to the chat
   model).
2. **The cartographer runs after every exchange**, replacing the
   every-3rd-message rule, in the background (FastAPI `BackgroundTasks`), so
   the tutor's reply is never delayed. If it fails (for example a 429), leave
   `last_extracted_message_id` where it is so the next exchange catches up; never
   loop retries. Expose its state so the UI can poll: a per-subject
   `graph_version` (incremented on every change) plus
   `cartographer: idle | running | error`.
3. **Rewrite the tutor prompt** (see "Tutor behaviour" below). Remove anything
   that makes it drip-feed one or two lines and then quiz. Keep the rule that the
   origin chat's first reply answers the whole question.
4. Context the tutor receives stays quiet background: the current topic, its
   prerequisites, its `part_of` parent and children, and nearby concepts. The
   tutor must never narrate it.
5. **Remove frontier entirely.** Drop the node `status` column and the
   `dismissed` state, the `/dismiss` endpoint, frontier output from the
   cartographer schema and prompt, and the frontier tests. Every node except the
   origin must have verified evidence or it is not created. Delete any existing
   frontier nodes in local databases (dev data only; no migration needed).
6. **Edge kinds** become `prerequisite`, `part_of` and `related`. Enforce at
   most one `part_of` parent per node (keep the first, skip and count later
   ones) and no cycles in `prerequisite` or `part_of`. Teach the cartographer
   when to use `part_of` (an overview's items are parts of the whole) and keep
   the rule that every prerequisite reason must match the arrow.
7. **Storage for traversal.** The graph stays an adjacency list (nodes table plus
   edges table). Add indexes on edges `(from_id)`, `(to_id)` and `(kind)`.
   Provide store helpers that use recursive SQL CTEs or BFS: `ancestors` and
   `descendants` by edge kind, `path(a, b)` (shortest path over all edges,
   ignoring direction), and `part_of_root(node)`.
8. Tests with FakeLLM: tutor and cartographer calls are separate; a cartographer
   failure does not break chat; catch-up after a failure; `graph_version`
   increments; no node without evidence; single `part_of` parent enforced; cycle
   checks per kind; traversal helpers. Then one live 6-message German chat; show
   Apoorv the replies and the resulting graph. Open the PR and stop.

### M2 `feat/ui`
React + TypeScript + Vite in `frontend/`, with React Flow for the graph.
- **Two screens**, switchable at any time, plus a subject list or picker
  (a home view or a slim left rail):
  1. **Chat screen**: a full chat for the current node. A small live mini graph
     sits in the top-right corner, highlights the current node and updates as
     the graph grows. Clicking the mini graph opens the graph screen.
  2. **Graph screen**: the full graph. Selecting a node opens its chat as a
     floating window in the bottom-right, like Gmail's compose window, with
     minimise, close and "expand to chat screen" controls. One window at a time
     for now; selecting another node switches the window to that node.
- **Chat** should feel like a normal AI chat app (in both the full screen and
  the window): markdown rendering (headings, lists, tables, code), Enter to
  send, Shift+Enter for a newline, a pending indicator, and errors shown clearly
  (429 means "rate limited, try again in a minute").
- **Graph**:
  - Every node looks the same apart from the highlighted origin and the current
    node. There are no frontier, suggestion or dismissed states.
  - Edge styles: `prerequisite` solid with an arrow, `part_of` a thin connector
    drawn toward the parent, `related` dashed with no arrow.
  - **Semantic zoom**: zoomed out, nodes collapse into their `part_of` ancestors
    (shown as a single node with a child count), and zooming in expands them.
    Use two or three discrete zoom thresholds and compute it at render time.
    Edges between collapsed nodes are merged.
  - The layout keeps `part_of` children near their parent and the origin
    central. New nodes briefly highlight when they appear.
  - Opening a node's chat records the trail with `from_node_id`.
  - The node detail (in the chat window header or a side drawer) shows the
    summary, the evidence quotes and the edges.
- A breadcrumb on the chat screen shows the trail.
- After each message, poll the graph status until the cartographer is idle,
  then refresh.
- A "context used" toggle on assistant messages, off by default (a
  development aid).
- Light and dark themes. **Visual direction is not decided yet** (decided
  2026-11-15): build with neutral greys and the system font. Every colour,
  font, size, radius and spacing value lives as a CSS variable in one theme
  file (`frontend/src/theme.css`); components use only those variables, so a
  design can be dropped in later without touching them.
- The visitor token is kept in `localStorage`, with a fallback when that is
  unavailable. The Vite dev server proxies `/api`. `make dev` starts the
  backend and frontend together.
- Add the frontend CI job (lint, typecheck, test, build), a few Vitest tests
  (API client, layout), and a Playwright screenshot of a real session for the
  README.
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

## Ideas parked for later (do not build now)
- Learner feedback raised GraphQL; REST is fine for a single client, so revisit
  only if the API grows.
- Ideas from Claude's memory architecture for long-term, per-subject context
  management.
- Tests and revision, the mastery rule, gamification, the optional starter-map
  ("show me the territory") view, narrative subjects, import from other
  platforms, deployment.

## Conventions
- Gemini model: `gemini-3.5-flash-lite` (free tier; confirmed working).
  Override with `DOCTUS_GEMINI_MODEL`.
- Run tests as `python -m pytest` with the venv active (`pytest` alone picks up
  Kali's system pytest). Never "fix" that by changing code or deleting tests.
- Default tests use `FakeLLM`; only `-m live` tests call Gemini. Space out live
  calls (free tier).
- Secrets live only in `.env` (git-ignored); `.env.example` documents them.
  Never print the key or ask for it in chat.
- All model calls go through `doctus.llm.LLM`; structured output is validated
  with Pydantic and retried once.
- Time-boxed: cut scope rather than extend. Ask Apoorv before adding anything
  not listed here.
