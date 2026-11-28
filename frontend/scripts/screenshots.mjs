// Screenshots of the P0 prototype (not part of CI).
//
//   node scripts/screenshots.mjs --out ../docs/screenshots/p0
//
// Needs the Vite dev server running (`npm run dev`). The prototype keeps its
// data in the browser, so every run starts from the seed. Set CHROMIUM_PATH
// to use a system Chromium instead of Playwright's own download.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:5173' },
    out: { type: 'string', default: 'screenshots' },
  },
})
mkdirSync(a.out, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const shot = async (name) => {
  const file = join(a.out, `${name}.png`)
  await page.waitForTimeout(700) // let transitions settle
  await page.screenshot({ path: file })
  console.log(file)
}
const node = (title) => page.locator('.react-flow__node', { hasText: title })
const openNode = async (title) => {
  if (!(await page.locator('.node-card').count())) await page.locator('.crumbs a').nth(1).click()
  await node(title).locator('.node-card').click()
}
const edgeBetween = async (t1, t2) => {
  const id = async (t) => node(t).getAttribute('data-id')
  const [x, y] = [Number(await id(t1)), Number(await id(t2))].sort((p, q) => p - q)
  return page.locator(`.react-flow__edge[data-id="${x}-${y}"] .react-flow__edge-interaction`)
}

await page.goto(`${a.base}/`)
await page.waitForSelector('.space-card')
await page.click('.space-card >> nth=0')
await page.waitForSelector('.node-card')
await shot('space')
await page.click('button:has-text("Arrange")')
await page.waitForTimeout(800)
await node('Pets endpoints').hover()
await shot('space-arranged')

// Connection view, with reasons selected across two connections.
await (await edgeBetween('Checkout flow design', 'Store / orders')).dispatchEvent('click')
await page.waitForSelector('.reason-table tbody tr')
await page.locator('.reason-table tbody tr input[type=checkbox]').nth(0).check()
await page.locator('.reason-table tbody tr input[type=checkbox]').nth(1).check()
await (await edgeBetween('Pets endpoints', 'Checkout flow design')).dispatchEvent('click')
await page.waitForSelector('.reason-table tbody tr')
await page.locator('.reason-table tbody tr input[type=checkbox]').nth(0).check()
await shot('connection')
await page.click('text=New node from selection…')
await page.fill('.dialog input[placeholder]', 'Checkout data flow')
await shot('new-node')
await page.keyboard.press('Escape')

// Space widgets: the tracker (a space-defined type).
await page.click('.connection-win [aria-label="Close connection"]')
await page.click('[aria-label="Minimise Space chat"]')
await page.click('[aria-label^="Expand Space widgets"]')
await shot('tracker')
await page.click('[aria-label^="Minimise Space widgets"]')
await page.click('[aria-label="Expand Space chat"]')

// Inside nodes.
await openNode('Pets endpoints')
await page.waitForSelector('.widget-card')
await page.locator('.widget-card', { hasText: '/pet/{petId}' }).locator('.reasons-toggle').click()
await shot('node')
await openNode('Open decisions')
await page.waitForSelector('.widget-card')
await shot('decisions')

// The scripted agent building the empty space.
await page.click('.crumbs a >> nth=0')
await page.click('.space-card:has-text("Try it")')
await page.click('.prompt-chip')
await page.waitForTimeout(9000)
await shot('agent')
await page.goto(`${a.base}/`)
await page.waitForSelector('.space-card')
await shot('home')

await browser.close()
