// Screenshots of a running dev session (not part of CI).
//
//   node scripts/screenshots.mjs --subject 1 --visitor <token> --out ../docs/screenshots --label after
//
// Needs `make dev` (or the Vite dev server) running. Set CHROMIUM_PATH to use
// a system Chromium instead of Playwright's own download.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:5173' },
    subject: { type: 'string' },
    visitor: { type: 'string' },
    out: { type: 'string', default: 'screenshots' },
    label: { type: 'string', default: 'shot' },
    zooms: { type: 'string', default: '1,0.6,0.4,min' },
    window: { type: 'string' }, // node id for the chat window shot
    chat: { type: 'string' }, // node id for the chat screen shot
    theme: { type: 'string', default: 'light' },
    only: { type: 'string', default: 'zoom,chat,window' },
  },
})
if (!a.subject || !a.visitor) throw new Error('--subject and --visitor are required')
mkdirSync(a.out, { recursive: true })
const only = new Set(a.only.split(','))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: a.theme,
  deviceScaleFactor: 1,
})
await ctx.addInitScript((token) => localStorage.setItem('doctus.visitor', token), a.visitor)
const page = await ctx.newPage()
const shot = async (name) => {
  const file = join(a.out, `${a.label}-${name}.png`)
  await page.waitForTimeout(700) // let transitions settle
  await page.screenshot({ path: file })
  console.log(file)
}

if (only.has('zoom')) {
  await page.goto(`${a.base}/s/${a.subject}/graph`)
  await page.waitForSelector('.react-flow__node')
  await page.waitForFunction(() => window.__doctusFlow)
  for (const z of a.zooms.split(',')) {
    await page.evaluate(async (zoom) => {
      const rf = window.__doctusFlow
      // 'min': ask for a tiny zoom; zoomTo clamps it to minZoom.
      await rf.zoomTo(zoom === 'min' ? 0.0001 : Number(zoom))
      // Centre on the whole graph (all nodes, merged or not).
      const b = rf.getNodesBounds(rf.getNodes())
      await rf.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: rf.getZoom() })
    }, z)
    const actual = await page.evaluate(() => window.__doctusFlow.getZoom())
    await shot(`graph-zoom-${z === 'min' ? `min-${actual.toFixed(2)}` : z}`)
  }
}

if (only.has('chat') && a.chat) {
  await page.goto(`${a.base}/s/${a.subject}/chat/${a.chat}`)
  await page.waitForSelector('.msg-assistant')
  await shot('chat-screen')
}

if (only.has('window') && a.window) {
  await page.goto(`${a.base}/s/${a.subject}/graph?open=${a.window}`)
  await page.waitForSelector('.chat-window .msg-assistant, .chat-window .empty-thread')
  await page.evaluate(() => window.__doctusFlow?.fitView({ padding: 0.15 }))
  await shot('chat-window')
}

await browser.close()
