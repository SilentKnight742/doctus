# Doctus

A visual workspace where an AI helps you build **worlds** and the
**connections** between them, on one canvas. The v1 flagship is product
managers: understanding or improving a product through its endpoints, designs,
flows and decisions.

> **Status: P0, a clickable prototype.** The UI below runs entirely in the
> browser on a mock API, and the agents are **scripted demos**, not a model.
> The data shapes match what the N1 backend will serve. The product was
> redirected on 2026-11-28; the v1 learning product (tutor, cartographer,
> concepts) is in git history and its backend is removed in N1.

![Demo: the space agent builds a Petstore space, reasons become a new world, a world agent edits an endpoint](docs/demo/p0-demo.gif)

The same flow as video: [docs/demo/p0-demo.webm](docs/demo/p0-demo.webm)
(25 s, 2× speed). Screenshots in both themes:
[docs/screenshots/p0/](docs/screenshots/p0/).

## The idea

- **Space**: one canvas of worlds.
- **World**: an object on the space canvas. Inside it is its own canvas of
  widgets, plus its own AI chat.
- **Widget**: a typed item in a world (note, image, link, table, checklist,
  OpenAPI endpoint, …), freely placed and resized.
- **Reason**: one way two worlds relate: a widget in world A ↔ a widget in
  world B, with a kind, a one-line explanation and an author (AI or user).
- **Connection**: derived, never drawn. Two worlds are connected iff at least
  one reason links them; the space canvas draws one line per pair, thicker
  with more reasons.

## What the prototype shows

![The space canvas](docs/screenshots/p0/light-space.png)

- **Space canvas** (React Flow): worlds as cards (title, summary, widget
  count, widget types); drag to arrange, positions saved. One line per pair
  of worlds, its width and label from the reason count.
- **Connection view**: click a line for a table of its reasons (kind, text,
  AI/User, both widgets with jump links). Edit, delete, or add a reason.
  Select reasons **across several connections**; the tray then offers
  **New world from selection**, which copies (default) or moves the
  referenced widgets. Copies keep `copied_from` and show where they came
  from; moved widgets keep all their reasons.
- **Inside a world**: a canvas of widgets. Drag by the header, resize when
  selected, double-click (or ✎) to edit in place, × to delete (with its
  reasons). Each widget shows its reasons (⇄ n) with jumps to the widget in
  the other world, which is centred and flashed.
- **Widgets are data-defined.** A widget type is a schema of primitive
  fields (`text`, `number`, `date`, `bool`, `enum`, `url`, `file`, `ref`,
  `code`, `list`, `table`) plus a view template (`card`, `table`, `list`,
  `checklist`, `embed`, `image`). Renderers and editors are generic: one per
  template and one per primitive. Widget data is validated against its
  schema on every write, and errors show in the editor.
- **A type that is not built in**: the space agent defines a **Decision**
  type for the Petstore space (question, status, owner, due date, options
  table, outcome) and the Open decisions world uses it, through exactly the
  same system as the built-ins.
- **Space-level widgets**: the Space widgets tab holds **Launch readiness**,
  a tracker (another space-defined type: items with a world reference, owner,
  status and due date, with a progress bar).
- **Space chat and world chat** with scripted agents. Suggested prompts are
  shown as chips; the reply streams, and every tool call shows as a line
  (✓ or a rejection). The canvas updates as the agent works, and Stop keeps
  what was done so far. The space agent can instruct a world agent; that
  exchange appears in the world's chat.
  - Empty space: "I'm a PM improving the Swagger Petstore API" builds six
    worlds, 22 widgets, the Decision and Tracker types, 13 reasons and
    the tracker.
  - Space: find more links between Checkout and Store; update launch
    readiness from the worlds.
  - Pets endpoints: add the 404 response to `GET /pet/{petId}`.
  - Open decisions: turn the open questions into a checklist.
  - Any world: tidy into a grid.
  - Anything else gets a short "this is a scripted prototype" reply.

Inside a world, and the space-defined Decision type:

![Inside the Pets endpoints world](docs/screenshots/p0/light-world.png)
![Decisions (a space-defined type)](docs/screenshots/p0/dark-decisions.png)

## How the prototype works

- `frontend/src/api/client.ts` defines `DoctusApi`, the interface every
  screen uses. In P0 it is backed by `frontend/src/mock/`; N1 adds an HTTP
  implementation of the same interface.
- `mock/db.ts` holds the data and every rule: schema validation, the evidence
  rule (a reason needs two existing widgets in worlds of one space), cascades
  (widget → its reasons; world → its widgets), connection derivation, copy vs
  move. Pure TypeScript with unit tests, as a spec for N1.
- `mock/agents/` holds the tools the N2 agents will have
  (`create_world`, `create_widget`, `update_widget`, `add_reason`,
  `define_type`, `arrange_widgets`, …) and the scripted runner. Tool calls go
  through the same validation as the UI; a world agent may only touch its own
  world. The seed is the headline script played instantly, so the seeded
  space and the live demo match.
- Data is kept in `localStorage` under a schema version
  (`doctus.proto.version`). When the version changes, the saved data is
  dropped and the seed is loaded again. Every storage access is guarded;
  without storage the data lives in memory. **Reset demo** (left rail)
  reloads the seed.

Endpoint data follows the public Swagger Petstore (OpenAPI 3) sample. Team
names, tickets, numbers and the checkout wireframe are invented for the demo.

## Run it

Needs Node 24 with npm (and GNU Make). The prototype needs no backend and no
API key.

```bash
cd frontend && npm ci && npm run dev    # http://localhost:5173
```

## Tests and lint

```bash
make test-frontend   # Vitest: schema validation, mock rules, agent scripts, storage
make lint-frontend   # oxlint and tsc
make test            # also runs the v1 backend tests (until N1 removes them)
```

Screenshots and the demo recording (not part of CI; Playwright, optionally
with a system Chromium; the dev server must be running):

```bash
cd frontend
CHROMIUM_PATH=/usr/bin/chromium node scripts/screenshots.mjs --out ../docs/screenshots/p0 --theme light
CHROMIUM_PATH=/usr/bin/chromium node scripts/record-demo.mjs --out ../docs/demo
python3 scripts/frames-to-gif.py ../docs/demo/frames ../docs/demo/p0-demo.gif \
  --video ../docs/demo/p0-demo.webm --ffmpeg ~/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux
```

`record-demo.mjs` captures Chrome's screencast frames with their timestamps;
`frames-to-gif.py` (Pillow) builds the GIF and pipes the frames to ffmpeg for
the video. The small ffmpeg that Playwright ships can write `.webm`. An
`.mp4` needs a full ffmpeg (`--video …/p0-demo.mp4 --ffmpeg ffmpeg`).

## Layout

```
frontend/src/
  api/        DoctusApi interface, v2 data shapes, errors (429/503 + Retry-After), SSE parser
  mock/       in-browser db and rules, persistence, seed, mock API
    agents/   agent tools, scripted runner, the Petstore scripts
  schema/     built-in widget types, the Decision and Tracker types, validation
  widgets/    renderers per view template, field display/editors per primitive
  space/      space canvas, world cards, connection lines and view, new world dialog,
              space widgets
  world/      world canvas, widget nodes (drag, resize, edit, reasons)
  chat/       chat panel, messages with tool lines, composer, markdown
  shell/      left rail, side panel
  theme.css   design tokens, light and dark
backend/      the v1 learning backend, removed in N1
```

## Next

N1 data model and API (FastAPI + SQLite, the same shapes), N2 space and world
agents (Gemini by default; Anthropic and OpenAI; bring your own key), N3/N4
connect these screens to the real API, N5 OpenAPI import, uploads and an MCP
server. See `CLAUDE.md`.

## Current limits (prototype)

- Agents are scripted: only the suggested prompts do anything.
- Data lives in one browser; there is no server and no sharing.
- Uploaded images are stored inline in `localStorage` (a few MB at most).
- The generic `table` widget has up to five text columns, named by its
  `columns` list; user-defined column types come with user-defined widget
  types.
- Widget references (`ref`) are shown and edited for worlds; widget-to-widget
  references are supported by the schema but not used in the seed.
- The palette is provisional; a design pass comes later.

## License

To be decided.
