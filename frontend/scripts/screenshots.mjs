// Screenshots of a running dev session (not part of CI).
//
//   node scripts/screenshots.mjs --subject 1 --visitor <token> --out ../docs/screenshots/m4a \
//     --theme light --open 3
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
    theme: { type: 'string', default: 'light' },
    open: { type: 'string' }, // canvas node id to open in the side panel
    select: { type: 'string' }, // canvas node id to select for the canvas shot
  },
})
if (!a.subject || !a.visitor) throw new Error('--subject and --visitor are required')
mkdirSync(a.out, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: a.theme,
  deviceScaleFactor: 1,
})
await ctx.addInitScript((token) => localStorage.setItem('doctus.visitor', token), a.visitor)
const page = await ctx.newPage()
const shot = async (name) => {
  const file = join(a.out, `${a.theme}-${name}.png`)
  await page.waitForTimeout(800) // let transitions settle
  await page.screenshot({ path: file })
  console.log(file)
}

await page.goto(`${a.base}/s/${a.subject}`)
await page.waitForSelector('.canvas.is-ready .card-node')
if (a.select) await page.click(`.react-flow__node[data-id="${a.select}"] .card-prompt`)
await shot('canvas')

if (a.open) {
  await page.click(`.react-flow__node[data-id="${a.open}"] .card-open`)
  await page.waitForSelector('.side-panel .msg-assistant')
  await shot('panel')
}

await page.goto(`${a.base}/`)
await page.waitForSelector('.home-card')
await shot('home')

await browser.close()
