// Records the P0 demo flow (not part of CI).
//
//   node scripts/record-demo.mjs --out ../docs/demo
//
// Writes a `frames/` folder of PNG frames (Chrome's screencast) and their
// timestamps (`times.json`), which
// `scripts/frames-to-gif.py` turns into a GIF and ffmpeg into a video (see
// that script). Needs the Vite dev server running; starts from the seed.
import { chromium } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:5173' },
    out: { type: 'string', default: 'demo' },
    theme: { type: 'string', default: 'light' },
  },
})
const size = { width: 1280, height: 800 }
const frames = join(a.out, 'frames')
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({ viewport: size, colorScheme: a.theme })
const page = await ctx.newPage()
const pause = (ms) => page.waitForTimeout(ms)

// Chrome's screencast: a frame on every repaint, with its timestamp.
const times = []
const cdp = await ctx.newCDPSession(page)
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  writeFileSync(join(frames, `${String(times.length).padStart(5, '0')}.png`), Buffer.from(data, 'base64'))
  times.push(metadata.timestamp)
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: size.width, maxHeight: size.height })

const world = (t) => page.locator('.rail-world', { hasText: t })
const edge = async (t1, t2) => {
  const id = async (t) => Number((await world(t).getAttribute('href')).split('/').pop())
  const [x, y] = [await id(t1), await id(t2)].sort((p, q) => p - q)
  return page.locator(`.react-flow__edge[data-id="${x}-${y}"] .react-flow__edge-interaction`)
}

// 1. An empty space; the scripted space agent builds it.
await page.goto(`${a.base}/`)
await page.waitForSelector('.space-card')
await pause(1200)
await page.click('.space-card:has-text("Try it")')
await page.waitForSelector('.prompt-chip')
await pause(1200)
await page.click('.prompt-chip')
await page.waitForSelector('.chat-running')
await page.waitForSelector('.chat-running', { state: 'detached', timeout: 120000 })
await pause(2000)

// 2. Why do Checkout and Store connect? Select reasons across two connections.
await (await edge('Checkout flow design', 'Store / orders')).dispatchEvent('click')
await page.waitForSelector('.reason-table tbody tr')
await pause(1800)
await page.locator('.reason-table tbody input[type=checkbox]').nth(0).check()
await pause(500)
await page.locator('.reason-table tbody input[type=checkbox]').nth(1).check()
await pause(900)
await (await edge('Pets endpoints', 'Checkout flow design')).dispatchEvent('click')
await pause(1400)
await page.locator('.reason-table tbody input[type=checkbox]').nth(0).check()
await pause(1200)

// 3. New world from selection (copy).
await page.click('text=New world from selection…')
await pause(600)
await page.locator('.dialog input[placeholder]').pressSequentially('Checkout data flow', { delay: 45 })
await pause(900)
await page.click('.dialog button[type=submit]')
await page.waitForSelector('.toast')
await pause(1600)
await page.click('.toast a')
await page.waitForSelector('.widget-card')
await pause(2200)

// 4. Inside a world: the world agent edits an endpoint.
await world('Pets endpoints').click()
await page.waitForSelector('.widget-card')
await pause(1500)
await page.click('.prompt-chip:has-text("404")')
await page.waitForSelector('.chat-running')
await page.waitForSelector('.chat-running', { state: 'detached', timeout: 60000 })
await pause(2200)

// 5. Back to the space: the launch-readiness tracker.
await page.click('.back-link')
await page.waitForSelector('.world-card')
await page.click('role=tab[name=/Space widgets/]')
await pause(2500)

await cdp.send('Page.stopScreencast')
writeFileSync(join(frames, 'times.json'), JSON.stringify(times))
const n = times.length
await ctx.close()
await browser.close()
console.log(frames, `${n} frames`)
