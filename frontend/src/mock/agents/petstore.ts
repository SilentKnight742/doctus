/*
 * The demo content: "Improving the Swagger Petstore API". The headline
 * script builds the whole space through agent tools; the seed plays the
 * same script instantly, so the seeded space and the live demo agree.
 *
 * Endpoints follow the public Swagger Petstore (OpenAPI 3) sample. Team
 * names, tickets and numbers are invented for the demo.
 */
import type { ChatScope, Row } from '../../api/types'
import { decisionType, trackerType } from '../../schema/custom'
import type { Db } from '../db'
import type { Script, Step } from './runner'

const P = 'Pets endpoints'
const S = 'Store / orders'
const U = 'Users / auth'
const C = 'Checkout flow design'
const D = 'Open decisions'
const M = 'Metrics & feedback'

const param = (name: string, where: string, type: string, required: boolean): Row => ({
  name,
  in: where,
  type,
  required,
})
const resp = (status: string, description: string): Row => ({ status, description })

function endpoint(
  world: string,
  method: string,
  path: string,
  summary: string,
  opts: { params?: Row[]; request?: string; responses: Row[]; x: number; y: number; h?: number },
): Step {
  return {
    call: {
      tool: 'create_widget',
      args: {
        world_id: `@world:${world}`,
        type: 'openapi_endpoint',
        data: {
          method,
          path,
          summary,
          parameters: opts.params ?? [],
          request: opts.request ?? '',
          responses: opts.responses,
        },
        x: opts.x,
        y: opts.y,
        h: opts.h,
      },
    },
  }
}

function widget(world: string, type: string, data: Record<string, unknown>, x: number, y: number, w?: number, h?: number): Step {
  return { call: { tool: 'create_widget', args: { world_id: `@world:${world}`, type, data, x, y, w, h } } }
}

function reason(a: string, b: string, kind: string, text: string): Step {
  return { call: { tool: 'add_reason', args: { widget_a: `@widget:${a}`, widget_b: `@widget:${b}`, kind, text } } }
}

function world(title: string, summary: string, colour: string, x: number, y: number): Step {
  return { call: { tool: 'create_world', args: { title, summary, colour, x, y } } }
}

const decision = (
  question: string,
  status: string,
  owner: string,
  due: string,
  options: [string, string][],
  outcome: string,
  x: number,
  y: number,
): Step =>
  widget(
    D,
    'decision',
    { question, status, owner, due, options: options.map(([option, tradeoff]) => ({ option, tradeoff })), outcome },
    x,
    y,
    380,
    300,
  )

// ---------- the headline script ----------

const PETSTORE_STEPS: Step[] = [
  {
    say:
      'Let’s map the Petstore API around what you’re improving. I’ll make one **world** per area ' +
      '(pets, store, users), one for the checkout design, one for open decisions and one for metrics, ' +
      'then connect them with **reasons**.',
  },
  world(P, 'The /pet operations: add, find, read and update pets.', 'indigo', 0, 20),
  world(S, 'Orders and inventory under /store.', 'teal', 330, 0),
  world(U, 'Users, login and how clients authenticate.', 'sky', 660, 30),
  world(C, 'The buyer’s path from browsing to a placed order.', 'rose', 330, 290),
  world(D, 'Product decisions still open, with owners and dates.', 'amber', 660, 310),
  world(M, 'Support tickets and the checkout funnel.', 'olive', 0, 300),
  { say: 'Now the endpoints, from the Petstore OpenAPI spec.' },
  endpoint(P, 'GET', '/pet/findByStatus', 'Finds pets by status.', {
    params: [param('status', 'query', 'string: available | pending | sold', true)],
    responses: [resp('200', 'A list of pets'), resp('400', 'Invalid status value')],
    x: 40,
    y: 40,
    h: 290,
  }),
  endpoint(P, 'GET', '/pet/{petId}', 'Returns a single pet.', {
    params: [param('petId', 'path', 'integer (int64)', true)],
    responses: [resp('200', 'The pet'), resp('400', 'Invalid ID supplied')],
    x: 440,
    y: 40,
    h: 290,
  }),
  endpoint(P, 'POST', '/pet', 'Add a new pet to the store.', {
    request: '{\n  "name": "doggie",\n  "photoUrls": ["https://…"],\n  "status": "available"\n}',
    responses: [resp('200', 'Successful operation'), resp('400', 'Invalid input'), resp('422', 'Validation exception')],
    x: 40,
    y: 370,
    h: 330,
  }),
  endpoint(P, 'PUT', '/pet', 'Update an existing pet by id.', {
    request: '{\n  "id": 10,\n  "name": "doggie",\n  "status": "sold"\n}',
    responses: [resp('200', 'Successful operation'), resp('400', 'Invalid ID supplied'), resp('404', 'Pet not found')],
    x: 440,
    y: 370,
    h: 330,
  }),
  widget(
    P,
    'note',
    {
      title: 'Pet status lifecycle',
      body:
        '`available` → `pending` → `sold`\n\n' +
        'Today nothing enforces the order: any client with `write:pets` can jump straight to `sold`.',
    },
    840,
    40,
    300,
    200,
  ),
  widget(
    P,
    'link',
    {
      title: 'Petstore OpenAPI spec',
      url: 'https://petstore3.swagger.io/api/v3/openapi.json',
      description: 'The source spec (OpenAPI 3.0) these endpoints come from.',
    },
    840,
    280,
  ),
  endpoint(S, 'POST', '/store/order', 'Place an order for a pet.', {
    request: '{\n  "petId": 198772,\n  "quantity": 1,\n  "status": "placed"\n}',
    responses: [resp('200', 'Successful operation'), resp('400', 'Invalid input'), resp('422', 'Validation exception')],
    x: 40,
    y: 40,
    h: 330,
  }),
  endpoint(S, 'GET', '/store/order/{orderId}', 'Find a purchase order by id.', {
    params: [param('orderId', 'path', 'integer (int64)', true)],
    responses: [resp('200', 'The order'), resp('400', 'Invalid ID supplied'), resp('404', 'Order not found')],
    x: 440,
    y: 40,
    h: 330,
  }),
  endpoint(S, 'GET', '/store/inventory', 'Returns pet inventories by status.', {
    params: [param('api_key', 'header', 'string', true)],
    responses: [resp('200', 'Map of status to quantity')],
    x: 40,
    y: 410,
    h: 250,
  }),
  widget(
    S,
    'table',
    {
      title: 'Order status ↔ pet status',
      columns: [{ name: 'Order status' }, { name: 'Pet status' }, { name: 'Set by' }],
      rows: [
        { c1: 'placed', c2: 'pending', c3: 'POST /store/order', c4: '', c5: '' },
        { c1: 'approved', c2: 'pending', c3: 'Store admin', c4: '', c5: '' },
        { c1: 'delivered', c2: 'sold', c3: 'Fulfilment job', c4: '', c5: '' },
      ],
    },
    440,
    410,
  ),
  endpoint(U, 'GET', '/user/login', 'Logs a user into the system.', {
    params: [param('username', 'query', 'string', false), param('password', 'query', 'string', false)],
    responses: [resp('200', 'Session token; X-Rate-Limit, X-Expires-After headers'), resp('400', 'Invalid username/password')],
    x: 40,
    y: 40,
    h: 320,
  }),
  endpoint(U, 'POST', '/user', 'Create a user.', {
    request: '{\n  "username": "theUser",\n  "email": "john@email.com",\n  "password": "…"\n}',
    responses: [resp('200', 'Successful operation')],
    x: 440,
    y: 40,
    h: 300,
  }),
  widget(
    U,
    'note',
    {
      title: 'How clients authenticate today',
      body:
        '- **OAuth2** (`petstore_auth`): `read:pets`, `write:pets` for /pet writes.\n' +
        '- **api_key** header: /store/inventory only.\n' +
        '- **Login** returns a session token, but takes the password *in the query string*.',
    },
    40,
    400,
    360,
    210,
  ),
  widget(
    U,
    'link',
    {
      title: 'OWASP: data in query strings',
      url: 'https://owasp.org/www-community/vulnerabilities/Information_exposure_through_query_strings_in_url',
      description: 'Why credentials in URLs end up in logs and browser history.',
    },
    440,
    400,
  ),
  { say: 'Next the checkout design: the flow, a screenshot of the pet details step and the edge cases.' },
  widget(
    C,
    'note',
    {
      title: 'Checkout flow',
      body:
        '1. Browse available pets: `GET /pet/findByStatus?status=available`\n' +
        '2. Pet details: `GET /pet/{petId}`\n' +
        '3. Sign in: `GET /user/login`\n' +
        '4. Place order: `POST /store/order`\n' +
        '5. Confirmation: `GET /store/order/{orderId}`',
    },
    40,
    40,
    360,
    230,
  ),
  widget(
    C,
    'image',
    {
      title: 'Pet details step (wireframe)',
      image: { name: 'checkout-pet-details.svg', src: '/demo/checkout-pet-details.svg', kind: 'image' },
      caption: 'Step 2 of checkout. The “Reserve” button places the order.',
    },
    440,
    40,
    400,
    340,
  ),
  widget(
    C,
    'checklist',
    {
      title: 'Edge cases to design',
      items: [
        { done: true, text: 'Order fails with 400 (invalid input)' },
        { done: false, text: 'Pet sold while the buyer is in checkout' },
        { done: false, text: 'Session expires before the order is placed' },
        { done: true, text: 'Buyer goes back from confirmation' },
      ],
    },
    40,
    310,
    360,
    230,
  ),
  widget(
    M,
    'note',
    {
      title: 'Support tickets, last 30 days',
      body:
        '**41%** of checkout tickets: “my order failed but I was charged a hold” — almost all for pets ' +
        'that were sold while the buyer was checking out.',
    },
    40,
    40,
    320,
    190,
  ),
  widget(
    M,
    'table',
    {
      title: 'Checkout funnel',
      columns: [{ name: 'Step' }, { name: 'Sessions' }, { name: 'Drop-off' }],
      rows: [
        { c1: 'Browse', c2: '12,400', c3: '—', c4: '', c5: '' },
        { c1: 'Pet details', c2: '7,900', c3: '36%', c4: '', c5: '' },
        { c1: 'Sign in', c2: '3,100', c3: '61%', c4: '', c5: '' },
        { c1: 'Order placed', c2: '2,650', c3: '15%', c4: '', c5: '' },
      ],
    },
    400,
    40,
  ),
  {
    say:
      'Decisions need more than a note: an owner, options and a due date. I’ll define a **Decision** ' +
      'widget type for this space and ask the Open decisions agent to record them.',
  },
  { call: { tool: 'define_type', args: { type: decisionType(0) } } },
  {
    instruct: D,
    instruction: 'Record the three open questions about sold pets, login and reservations as decisions.',
    steps: [
      { say: 'Recording three decisions.' },
      decision(
        'Sold pets: 404 or 410 from GET /pet/{petId}?',
        'Open',
        'API team',
        '2026-12-12',
        [
          ['404 Not Found', 'Consistent with unknown ids; hides that the pet existed'],
          ['410 Gone', 'Truthful; clients must handle a new status'],
        ],
        '',
        40,
        40,
      ),
      decision(
        'Move login credentials out of the query string?',
        'Open',
        'Security',
        '2026-12-19',
        [
          ['POST body', 'Small change; still a custom login'],
          ['OAuth2 + PKCE', 'Standard for browser clients; more work'],
        ],
        '',
        460,
        40,
      ),
      decision(
        'Reserve the pet when an order is placed?',
        'Decided',
        'Product',
        '2026-11-20',
        [
          ['Reserve (pending)', 'No double-selling; needs a timeout'],
          ['No reserve', 'Simpler; sold-during-checkout failures stay'],
        ],
        'Yes: POST /store/order sets the pet to `pending`; released after 30 minutes.',
        40,
        380,
      ),
    ],
  },
  { say: 'Now the reasons that connect the worlds.' },
  reason(`${P}#GET /pet/{petId}`, `${D}#Sold pets: 404 or 410 from GET /pet/{petId}?`, 'decided by', 'What this returns for a sold pet waits on the 404 vs 410 decision.'),
  reason(`${P}#Pet status lifecycle`, `${S}#Order status ↔ pet status`, 'same data', 'Both describe the pet status changes an order causes.'),
  reason(`${P}#PUT /pet`, `${S}#Order status ↔ pet status`, 'contradicts', 'PUT /pet can set status=sold directly, skipping the order flow.'),
  reason(`${S}#POST /store/order`, `${D}#Reserve the pet when an order is placed?`, 'decided by', 'Placing an order now reserves the pet (pending).'),
  reason(`${S}#POST /store/order`, `${C}#Checkout flow`, 'implements', 'Step 4 of checkout calls POST /store/order.'),
  reason(`${S}#GET /store/order/{orderId}`, `${C}#Checkout flow`, 'implements', 'The confirmation step reads the order back.'),
  reason(`${P}#GET /pet/findByStatus`, `${C}#Checkout flow`, 'implements', 'Step 1 lists available pets with findByStatus.'),
  reason(`${U}#GET /user/login`, `${C}#Checkout flow`, 'depends on', 'Checkout step 3 signs the buyer in.'),
  reason(`${U}#GET /user/login`, `${D}#Move login credentials out of the query string?`, 'decided by', 'Login sends the password as a query parameter today.'),
  reason(`${U}#How clients authenticate today`, `${D}#Move login credentials out of the query string?`, 'informs', 'The current auth setup is the starting point for this decision.'),
  reason(`${C}#Edge cases to design`, `${D}#Sold pets: 404 or 410 from GET /pet/{petId}?`, 'depends on', '“Pet sold during checkout” needs the 404 vs 410 answer.'),
  reason(`${M}#Support tickets, last 30 days`, `${C}#Edge cases to design`, 'informs', 'Most failed-order tickets are the sold-during-checkout case.'),
  reason(`${M}#Checkout funnel`, `${C}#Pet details step (wireframe)`, 'informs', 'The pet details step loses 36% of sessions.'),
  {
    say:
      'Last, a space-level **tracker** so launch readiness is visible across worlds. ' +
      'Open a connection line to see the reasons behind it, or a world to see its widgets.',
  },
  { call: { tool: 'define_type', args: { type: trackerType(0) } } },
  {
    call: {
      tool: 'create_space_widget',
      args: {
        type: 'tracker',
        data: {
          title: 'Launch readiness',
          items: [
            { item: 'Answer 404 vs 410 for sold pets', world: { kind: 'world', id: `@world:${D}` }, owner: 'API team', status: 'In progress', due: '2026-12-12' },
            { item: 'Move login off the query string', world: { kind: 'world', id: `@world:${U}` }, owner: 'Security', status: 'Blocked', due: '2026-12-19' },
            { item: 'Reserve pet on order', world: { kind: 'world', id: `@world:${S}` }, owner: 'Backend', status: 'Ready', due: '2026-11-27' },
            { item: 'Checkout edge cases designed', world: { kind: 'world', id: `@world:${C}` }, owner: 'Design', status: 'In progress', due: '2026-12-05' },
            { item: 'Funnel tracking live', world: { kind: 'world', id: `@world:${M}` }, owner: 'Analytics', status: 'Not started', due: '2026-12-15' },
          ],
        },
      },
    },
  },
]

/** Reasons a person added in the seeded space (author: user). */
export const USER_REASONS: [string, string, string, string][] = [
  [`${S}#GET /store/inventory`, `${U}#How clients authenticate today`, 'depends on', 'Inventory needs the api_key header, which browser clients do not have.'],
  [`${P}#GET /pet/{petId}`, `${C}#Pet details step (wireframe)`, 'implements', 'The pet details step renders GET /pet/{petId}.'],
]

// ---------- helpers for the dynamic scripts ----------

const spaceOf = (db: Db, scope: ChatScope) => (scope.kind === 'space' ? scope.id : db.world(scope.id).space_id)
const worldNamed = (db: Db, scope: ChatScope, title: string) =>
  db.state.worlds.find((w) => w.space_id === spaceOf(db, scope) && w.title === title)
const inWorld = (db: Db, scope: ChatScope, title: string) => scope.kind === 'world' && db.world(scope.id).title === title
const findWidget = (db: Db, worldId: number, type: string, key: string, value: string) =>
  db.state.widgets.find((w) => w.world_id === worldId && w.type === type && w.data[key] === value)

function hasReason(db: Db, a: number, b: number) {
  return db.state.reasons.some((r) => (r.widget_a === a && r.widget_b === b) || (r.widget_a === b && r.widget_b === a))
}

// ---------- the scripts ----------

export const SCRIPTS: Script[] = [
  {
    id: 'petstore',
    scope: 'space',
    label: 'I’m a PM improving the Swagger Petstore API. Set up this space.',
    when: (db, scope) => !db.state.worlds.some((w) => w.space_id === scope.id),
    steps: PETSTORE_STEPS,
  },
  {
    id: 'link-checkout-store',
    scope: 'space',
    label: 'Find more links between Checkout and Store.',
    when: (db, scope) => !!worldNamed(db, scope, C) && !!worldNamed(db, scope, S),
    steps: [
      { say: 'Reading both worlds for links that are not there yet…' },
      {
        dynamic: (db, scope) => {
          const c = worldNamed(db, scope, C)!
          const s = worldNamed(db, scope, S)!
          const candidates: [number | undefined, number | undefined, string, string][] = [
            [
              findWidget(db, c.id, 'checklist', 'title', 'Edge cases to design')?.id,
              findWidget(db, s.id, 'openapi_endpoint', 'path', '/store/order')?.id,
              'depends on',
              '“Order fails with 400” is designed against POST /store/order’s error responses.',
            ],
            [
              findWidget(db, c.id, 'image', 'title', 'Pet details step (wireframe)')?.id,
              findWidget(db, s.id, 'table', 'title', 'Order status ↔ pet status')?.id,
              'same data',
              'The “Reserve” button moves the pet to pending, as the status table says.',
            ],
          ]
          const steps: Step[] = []
          for (const [a, b, kind, text] of candidates)
            if (a && b && !hasReason(db, a, b)) steps.push({ call: { tool: 'add_reason', args: { widget_a: a, widget_b: b, kind, text } } })
          if (!steps.length) return [{ say: 'I found no new links: every link I can justify is already there.' }]
          return [
            ...steps,
            { say: `Added ${steps.length} reason${steps.length > 1 ? 's' : ''}. The Checkout ↔ Store line is heavier now; click it to review them.` },
          ]
        },
      },
    ],
  },
  {
    id: 'update-tracker',
    scope: 'space',
    label: 'Update launch readiness from the worlds.',
    when: (db, scope) =>
      db.state.widgets.some((w) => w.space_id === scope.id && w.world_id == null && w.type === 'tracker'),
    steps: [
      { say: 'Checking each tracker item against its world…' },
      {
        dynamic: (db, scope) => {
          const tracker = db.state.widgets.find((w) => w.space_id === scope.id && w.world_id == null && w.type === 'tracker')!
          const items = (tracker.data.items as Row[]).map((r) => ({ ...r }))
          const notes: string[] = []
          const d = worldNamed(db, scope, D)
          const c = worldNamed(db, scope, C)
          const sold = d && findWidget(db, d.id, 'decision', 'question', 'Sold pets: 404 or 410 from GET /pet/{petId}?')
          const edge = c && findWidget(db, c.id, 'checklist', 'title', 'Edge cases to design')
          for (const it of items) {
            if (it.item === 'Answer 404 vs 410 for sold pets' && sold) {
              const s = sold.data.status === 'Decided' ? 'Ready' : 'In progress'
              if (it.status !== s) notes.push(`404 vs 410 → **${s}** (decision is ${sold.data.status})`)
              it.status = s
            }
            if (it.item === 'Checkout edge cases designed' && edge) {
              const list = edge.data.items as Row[]
              const done = list.filter((x) => x.done).length
              const s = done === list.length ? 'Ready' : 'In progress'
              if (it.status !== s) notes.push(`Edge cases → **${s}** (${done}/${list.length} done)`)
              else notes.push(`Edge cases: still ${done}/${list.length} done`)
              it.status = s
            }
          }
          return [
            { call: { tool: 'update_widget', args: { widget_id: tracker.id, data: { items } } } },
            { say: notes.length ? notes.map((n) => `- ${n}`).join('\n') : 'Nothing changed since the last update.' },
          ]
        },
      },
    ],
  },
  {
    id: 'add-404',
    scope: 'world',
    label: 'Add the 404 response to GET /pet/{petId}.',
    when: (db, scope) => inWorld(db, scope, P),
    steps: [
      {
        dynamic: (db, scope) => {
          const w = findWidget(db, scope.id, 'openapi_endpoint', 'path', '/pet/{petId}')
          if (!w) return [{ say: 'There is no GET /pet/{petId} widget in this world.' }]
          const rows = w.data.responses as Row[]
          if (rows.some((r) => r.status === '404'))
            return [{ say: 'GET /pet/{petId} already documents a 404.' }]
          return [
            { say: 'The spec returns **404 Pet not found** for unknown ids; our widget was missing it.' },
            {
              call: {
                tool: 'update_widget',
                args: { widget_id: w.id, data: { responses: [...rows, { status: '404', description: 'Pet not found' }] } },
              },
            },
            { say: 'Done. Whether a *sold* pet is also a 404 is still the open decision linked to this endpoint.' },
          ]
        },
      },
    ],
  },
  {
    id: 'decisions-checklist',
    scope: 'world',
    label: 'Turn the open questions into a checklist.',
    when: (db, scope) => inWorld(db, scope, D),
    steps: [
      {
        dynamic: (db, scope) => {
          const open = db.state.widgets.filter(
            (w) => w.world_id === scope.id && w.type === 'decision' && w.data.status === 'Open',
          )
          if (!open.length) return [{ say: 'Every decision here is decided or parked.' }]
          const exists = db.state.widgets.some((w) => w.world_id === scope.id && w.data.title === 'Open questions')
          if (exists) return [{ say: 'The “Open questions” checklist is already here.' }]
          return [
            { say: `${open.length} decisions are still open. Making a checklist with their owners and dates.` },
            {
              call: {
                tool: 'create_widget',
                args: {
                  type: 'checklist',
                  data: {
                    title: 'Open questions',
                    items: open.map((w) => ({ done: false, text: `${w.data.question} (${w.data.owner}, ${w.data.due})` })),
                  },
                  x: 460,
                  y: 380,
                  w: 380,
                  h: 220,
                },
              },
            },
          ]
        },
      },
    ],
  },
  {
    id: 'arrange',
    scope: 'world',
    label: 'Tidy this world into a grid.',
    when: (db, scope) => db.state.widgets.filter((w) => w.world_id === scope.id).length > 1,
    steps: [{ call: { tool: 'arrange_widgets', args: { columns: 3 } } }, { say: 'Arranged.' }],
  },
]
