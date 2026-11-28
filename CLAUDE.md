# Doctus v2: project context for Claude Code

Planning happens in claude.ai; building happens here. The product was redirected
on 2026-11-28 (the name will change later; keep "Doctus" until told otherwise).
User-experience first: build, try it, improve. Prefer a working slice over more
planning.

## What it is
A visual workspace where an AI helps you build **worlds** and the
**connections** between them, on one canvas.
- For researchers, investigators and creators in general; the **v1 flagship is
  product managers** (understanding or improving a product: its endpoints,
  designs, flows, decisions).
- Example: one world holds everything about one API endpoint: the relevant part
  of the OpenAPI spec, the design screenshot, the flow sketch, the open
  decisions, and an AI chat that knows all of it.
- Think Heptabase's function with a far more visual, AI-driven experience.
  Learning features (tutor, concepts, tests) are retired for now; they may
  return later.

## Vocabulary
- **Space**: the top level, one canvas of worlds (working name; Apoorv may
  rename it).
- **World**: an object on the space canvas. Inside, it is its own canvas of
  widgets, plus its own AI chat.
- **Widget**: a typed item inside a world (note, image, link, table, checklist,
  OpenAPI endpoint, ...), freely placed and resized on the world canvas.
- **Reason**: one way two worlds relate: widget in world A ↔ widget in world B,
  with a kind, a one-line explanation and an author (`ai` or `user`).
- **Connection**: derived, never drawn by hand. It exists between two worlds
  if and only if at least one reason links them.

## Core rules
1. **Widgets are data-defined.** A widget type is a schema (fields built from
   primitive types) plus a view template. Built-in v1 types use the same system
   as future user- or AI-defined types. No hand-coded one-off widget models.
   - Primitive field types: `text` (Markdown), `number`, `date`, `bool`,
     `enum`, `url`, `file` (image or document), `ref` (another widget or
     world), `code`, and `list` / `table` (rows of typed fields).
   - View templates: `card`, `table`, `list`, `checklist`, `embed`, `image`.
   - Widget data is validated against its type's schema on every write.
2. **Evidence rule (carried over).** Every reason must point to widgets that
   exist, checked in code; no valid references, no reason. Deleting a widget
   deletes its reasons; a connection with no reasons disappears.
3. **One line per pair.** The space canvas draws one connection line per pair
   of worlds, its weight scaled by the number of reasons. Clicking it opens the
   connection view.
4. **AI reasons are created directly** (not as suggestions), labelled as AI,
   and can be edited or removed. User-made reasons are labelled as user.
5. **New world from selection.** In connection views, the user selects reasons
   (across several connections); "New world from selection" creates a world with
   the referenced widgets **copied** (default) or **moved** (option). Copies
   keep a `copied_from` reference.
6. **Two AI layers**, separate prompts, both acting only through tools:
   - **Space agent**: creates worlds, adds reasons, instructs world agents.
   - **World agent**: chats inside a world; creates, edits and arranges widgets.
   - Tool calls are validated (schema, references) before they change anything.
     The agent never edits the database directly.
7. **Providers.** One LLM interface with text, streaming and tool calls.
   Providers: Gemini (default, `gemini-3.5-flash-lite`), Anthropic and OpenAI.
   - **Bring your own key**: in `.env` for local use, or per request from the
     browser (header), never stored server-side.
   - Free-tier limits are real: surface 429/503 clearly (already built), and
     keep agent loops capped (max steps per request).
8. **MCP server.** Doctus exposes its tools (list/create/update worlds,
   widgets, reasons; read a space) as an MCP server, so Claude Desktop or Claude
   Code can drive it as the agent. Same validation as the built-in agents.

## Reuse vs retire
- **Reuse**: FastAPI app structure, SQLite store patterns, visitor scoping, the
  LLM layer (FakeLLM, Gemini, error mapping incl. 429/503 with Retry-After),
  SSE streaming with stop, background-job runner patterns, CI, Makefile, the
  React + Vite + React Flow frontend scaffolding, API client and SSE parser,
  Markdown rendering, theme variables.
- **Retire** (delete in the first milestone, keep in git history): tutor,
  cartographer, concepts and evidence quotes, canvas branch tree, suggestions,
  mastery, trail, `part_of`, proposals, the M4a canvas screens. The old
  database is not migrated: v2 starts with a fresh schema (rename the old file
  to `doctus.db.v1`).

## Status
- v1 (learning product): M0-M3 merged; M4a (#6) merged or pending. M4b is
  cancelled. Check git before starting.
- 2026-11-28: product redirected (this file).

## Git workflow (unchanged, same as Videre)
- Never commit or push to `main`. One branch per milestone, Conventional
  Commits. Run lint and tests, open the PR with `gh pr create`, then **STOP**.
  Apoorv reviews and squash-merges. Start the next milestone only after he
  says `main` is updated (`git pull` first).
- Never force-push; never `--no-verify`.
- Push over HTTPS with Apoorv's saved GitHub login, never SSH. Remote:
  `https://github.com/SilentKnight742/doctus.git`.
- Commit identity: `Apoorv Chitnis <77118742+SilentKnight742@users.noreply.github.com>`.
- Show Apoorv a plan before each milestone and wait for his OK.

## v1 milestones (v2 product)

### P0 `feat/prototype`: clickable prototype of the whole vision (2-3 days)
Frontend only, inside the real `frontend/`, so the screens are reused later.
- A **mock API layer** behind the same API-client interface and data shapes N1
  will implement (spaces, worlds, widget types, widgets, reasons, connections),
  in memory, seeded with a realistic PM space: "Improving the Swagger Petstore
  API" (worlds such as Pets endpoints, Store/orders, Users/auth, Checkout flow
  design, Open decisions; widgets: OpenAPI endpoints, notes, a screenshot, a
  table, a checklist; 10-15 reasons across worlds).
- Screens: space canvas (worlds as cards, one line per pair weighted by
  reasons); connection view (reason table, jump links, multi-select across
  connections, "New world from selection" with copy/move); inside a world
  (widget canvas: drag, resize, edit in place; renderers chosen by view
  template); space chat and world chat panels.
- **Scripted agents**: canned conversations that create worlds, widgets and
  reasons step by step, with streaming-style text, so the flow is visible
  without a model. Clearly labelled as a demo in the UI.
- Remove the M4a canvas screens; keep the scaffolding. Traditional, restrained
  look; light and dark.
- Screenshots and a short screen recording of the demo flow; README marks it
  as a prototype. Open the PR and stop.

### N1 `feat/v2-foundation`: data model and API
- Remove the retired code and its tests (see Reuse vs retire).
- Tables: `spaces`, `worlds` (position, size, title, summary, colour),
  `widget_types` (schema JSON, view template, `builtin` flag), `widgets`
  (world, type, data JSON, position, size, `copied_from`), `reasons`
  (widget A, widget B, kind, text, author), plus chat messages per world and
  per space.
- Built-in widget types, defined through the type system: note, image, link,
  table, checklist, `openapi_endpoint` (method, path, summary, parameters,
  request/response schemas as table/code fields).
- Connections are computed from reasons (no table).
- REST endpoints: CRUD for spaces, worlds, widgets, reasons; get a space
  (worlds + connections with reason counts); get a connection (its reasons with
  both widgets); "new world from selection" (copy or move); list widget types.
- Tests: schema validation of widget data, reference checks on reasons, cascade
  on delete, connection derivation, copy vs move, visitor scoping, the bad-input
  sweep (no 500s).

### N2 `feat/agents`: space and world agents
- Extend the LLM interface with tool calls (Gemini function calling; Anthropic
  and OpenAI providers; FakeLLM scripted tool calls for tests).
- World agent (chat in a world, streamed): tools to create, update, arrange
  and delete widgets in that world, reading the world's widgets as context.
- Space agent (chat at the space level): tools to create worlds (with initial
  widgets), add reasons, and send an instruction to a world agent.
- Every tool call validated; invalid calls are reported back to the model once,
  then dropped. Max steps per request (default 8).
- Bring-your-own-key: provider and key from `.env` or a request header;
  never logged or stored.
- Tests with FakeLLM; then one live run: "I'm a PM improving the Swagger
  Petstore API" builds a space with several worlds and reasons. Show Apoorv the
  space JSON.

### N3 `feat/space-ui`: the space canvas
- Worlds as cards on a React Flow canvas (title, summary, widget count,
  preview); drag to arrange; positions saved.
- One connection line per pair, weight by reason count. Click it to open the
  connection view: a table of reasons (kind, text, author, both widgets, jump
  links), editable and deletable. Multi-select across connections, then "New
  world from selection" (copy or move).
- Space chat panel for the space agent. Plain background, light and dark
  themes, traditional look (design pass later).

### N4 `feat/world-ui`: inside a world
- Open a world: its own canvas of widgets (drag, resize, edit in place), a
  renderer per view template (driven by the widget type, not hand-written per
  widget), a world chat panel, and "back to space".
- Reasons touching a widget are shown on it, with jumps to the other world.

### N5 `feat/imports-mcp`: OpenAPI import, files, MCP
- Import an OpenAPI (Swagger) JSON/YAML file: one world per tag or path group,
  one `openapi_endpoint` widget per operation.
- Image and file upload for widgets (stored locally).
- MCP server exposing the tools (FastMCP), documented for Claude Desktop and
  Claude Code.
- Demo scenario for the README: the Petstore spec plus a few screenshots,
  turned into a space by the agent.

## Later (not v1)
User- and AI-defined widget types; trackers, to-dos, reminders and guides at the
space level; explainer videos (Manim-style); live Figma/Miro integrations (MCP
clients); web research with citations; use-case mods (investigation,
worldbuilding, trips, research); learning features; collaboration; a design
pass and theme; deployment.

## Conventions
- Gemini default model: `gemini-3.5-flash-lite`; override with env vars.
- Run tests as `python -m pytest` with the venv active, or `make test`.
- Default tests never call real APIs; `-m live` tests do. Space out live calls.
- Secrets only in `.env` (git-ignored); never print or log keys.
- Time-boxed: cut scope rather than extend. Ask Apoorv before adding anything
  not listed here.
