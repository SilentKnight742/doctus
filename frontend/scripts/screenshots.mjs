// Screenshots of the P0 prototype (not part of CI).
//
//   node scripts/screenshots.mjs --out ../docs/screenshots/p0 --theme light
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
    theme: { type: 'string', default: 'light' },
  },
})
mkdirSync(a.out, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: a.theme, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const shot = async (name) => {
  const file = join(a.out, `${a.theme}-${name}.png`)
  await page.waitForTimeout(700) // let transitions settle
  await page.screenshot({ path: file })
  console.log(file)
}
const world = (title) => page.locator('.rail-world', { hasText: title })
const edgeBetween = async (t1, t2) => {
  const id = async (t) => (await world(t).getAttribute('href')).split('/').pop()
  const [x, y] = [Number(await id(t1)), Number(await id(t2))].sort((p, q) => p - q)
  return page.locator(`.react-flow__edge[data-id="${x}-${y}"] .react-flow__edge-interaction`)
}

await page.goto(`${a.base}/`)
await page.waitForSelector('.space-card')
await page.click('.space-card >> nth=0')
await page.waitForSelector('.world-card')
await shot('space')

// Connection view, with reasons selected across two connections.
await (await edgeBetween('Checkout flow design', 'Store / orders')).dispatchEvent('click')
await page.waitForSelector('.reason-table tbody tr')
await page.locator('.reason-table tbody tr input[type=checkbox]').nth(0).check()
await page.locator('.reason-table tbody tr input[type=checkbox]').nth(1).check()
await (await edgeBetween('Pets endpoints', 'Checkout flow design')).dispatchEvent('click')
await page.waitForSelector('.reason-table tbody tr')
await page.locator('.reason-table tbody tr input[type=checkbox]').nth(0).check()
await shot('connection')
await page.click('text=New world from selection…')
await page.fill('.dialog input[placeholder]', 'Checkout data flow')
await shot('new-world')
await page.keyboard.press('Escape')

// Space widgets: the tracker (a space-defined type).
await page.click('role=tab[name=/Space widgets/]')
await shot('tracker')

// Inside worlds.
await world('Pets endpoints').click()
await page.waitForSelector('.widget-card')
await page.locator('.widget-card', { hasText: '/pet/{petId}' }).locator('.reasons-toggle').click()
await shot('world')
await world('Open decisions').click()
await page.waitForSelector('.widget-card')
await shot('decisions')

// The scripted agent building the empty space.
await page.click('.rail-item >> text=Try it: an empty space')
await page.click('.prompt-chip')
await page.waitForTimeout(9000)
await shot('agent')

await browser.close()
