import type { Buffer } from 'node:buffer'
import type { Browser, BrowserContext, Page } from 'playwright-chromium'
import { importPlaywright } from '../commands/export'

/**
 * Headless rendering for the MCP server: drives a running dev server with
 * Playwright to screenshot a slide and/or collect compilation errors.
 *
 * The waiting logic mirrors `commands/export.ts` (`go()`), but is kept
 * separate on purpose: `export.ts` is a large, test-gated function (see
 * `plans/022`/`plans/023`), so we reuse only its Playwright resolver
 * (`importPlaywright`) rather than refactoring it.
 */

export interface CapturedError {
  type: 'vite-overlay' | 'console' | 'pageerror'
  message: string
}

export interface RenderCommonOptions {
  /** Base URL of the running dev server, e.g. `http://localhost:3030/`. */
  serverUrl: string
  /** Canvas width in px (`config.canvasWidth`). */
  width: number
  /** Canvas height in px (`round(canvasWidth / aspectRatio)`). */
  height: number
  /** Navigation/wait timeout in ms. */
  timeout?: number
  /** Playwright `waitUntil` strategy. */
  waitUntil?: 'networkidle' | 'load' | 'domcontentloaded'
}

export interface ScreenshotOptions extends RenderCommonOptions {
  /** 1-based slide number. */
  no: number
  /** Click animation step to reveal (0 = initial state). */
  clicks?: number
  /** Render in dark mode (only honored when the deck's `colorSchema` is `auto`). */
  dark?: boolean
  /** Device scale factor (higher = sharper, larger PNG). */
  scale?: number
}

export interface ScreenshotResult {
  buffer: Buffer
  /** Total clicks of the slide, as computed by the client (best-effort). */
  clicksTotal: number
  /** Clicks actually shown (requested value clamped to `clicksTotal`). */
  clicksShown: number
  errors: CapturedError[]
}

export interface CollectErrorsOptions extends RenderCommonOptions {
  /** 1-based slide number to load. */
  no: number
  dark?: boolean
}

const DEFAULT_TIMEOUT = 30_000
const IDLE_CLOSE_MS = 60_000

let browserPromise: Promise<Browser> | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = importPlaywright()
      .then(pw => pw.chromium.launch())
      .catch((e) => {
        browserPromise = undefined
        throw e
      })
  }
  return browserPromise
}

function scheduleIdleClose() {
  if (idleTimer)
    clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void closeRenderBrowser(), IDLE_CLOSE_MS)
  idleTimer.unref?.()
}

/** Close the cached browser (called on idle and on dev-server shutdown). */
export async function closeRenderBrowser(): Promise<void> {
  const p = browserPromise
  browserPromise = undefined
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  if (p) {
    try {
      await (await p).close()
    }
    catch {}
  }
}

function joinUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/$/, '')}/${path}`
}

async function newSlideContext(browser: Browser, opts: {
  width: number
  height: number
  dark: boolean
  scale?: number
}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale ?? 1,
    colorScheme: opts.dark ? 'dark' : 'light',
  })
  // Force the color scheme before the app boots. Slidev's `useDark` reads
  // `localStorage['slidev-color-schema']`; setting it wins over the system
  // preference when the deck's `colorSchema` is `auto` (the default).
  await context.addInitScript((scheme) => {
    try {
      localStorage.setItem('slidev-color-schema', scheme)
    }
    catch {}
  }, opts.dark ? 'dark' : 'light')
  return context
}

/**
 * Browser/runtime noise that is not a Slidev compilation or authoring error
 * (headless permission denials, external resource/cert failures, devtools
 * hints, etc.). Vite/Vue transform errors and Vue warnings are NOT matched.
 */
const BENIGN_ERROR_PATTERNS: RegExp[] = [
  /Wake Lock/i,
  /Failed to load resource/i,
  /net::ERR_/i,
  /ERR_CERT/i,
  /favicon/i,
  /Download the Vue Devtools/i,
  /\[vite\] connect/i,
]

function isBenign(message: string): boolean {
  return BENIGN_ERROR_PATTERNS.some(re => re.test(message))
}

function dedupeErrors(errors: CapturedError[]): CapturedError[] {
  const seen = new Set<string>()
  return errors.filter((e) => {
    const key = `${e.type}:${e.message}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function attachErrorCollector(page: Page): CapturedError[] {
  const errors: CapturedError[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isBenign(msg.text()))
      errors.push({ type: 'console', message: msg.text() })
  })
  page.on('pageerror', (err) => {
    if (!isBenign(err.message))
      errors.push({ type: 'pageerror', message: err.message })
  })
  return errors
}

/** Read the Vite dev-server error overlay (if any) from the page. */
async function readViteOverlay(page: Page): Promise<CapturedError[]> {
  const parts = await page.evaluate(() => {
    const el = document.querySelector('vite-error-overlay')
    const root = el?.shadowRoot
    if (!root)
      return null
    const text = (sel: string) => root.querySelector(sel)?.textContent?.trim() ?? ''
    return {
      message: text('.message'),
      file: text('.file'),
      frame: text('.frame'),
    }
  }).catch(() => null)
  if (!parts)
    return []
  const message = [parts.file, parts.message, parts.frame].filter(Boolean).join('\n')
  return message ? [{ type: 'vite-overlay', message }] : []
}

/**
 * Navigate to a slide URL and wait for it to finish rendering. Uses the
 * per-slide `play` route (`/:no`), which serves both play mode and, with
 * `?print=clicks`, a clean single-slide print frame (the one-piece `/print`
 * route is export-mode only and unavailable on a dev server).
 */
async function navigateAndWait(
  page: Page,
  url: string,
  no: number,
  opts: RenderCommonOptions & { dark?: boolean },
): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const waitUntil = opts.waitUntil ?? 'networkidle'

  await page.goto(url, { waitUntil, timeout })
  if (waitUntil)
    await page.waitForLoadState(waitUntil, { timeout }).catch(() => {})
  await page.emulateMedia({ colorScheme: opts.dark ? 'dark' : 'light', media: 'screen' })

  const slide = page.locator(`[data-slidev-no="${no}"]`)
  // If the deck fails to compile, the slide may never mount; don't hang the
  // whole call — the caller still reports collected errors.
  await slide.waitFor({ timeout }).catch(() => {})

  // Wait for slide loading placeholders to detach.
  const loaders = slide.locator('.slidev-slide-loading')
  const loaderCount = await loaders.count().catch(() => 0)
  for (let i = 0; i < loaderCount; i++)
    await loaders.nth(i).waitFor({ state: 'detached', timeout }).catch(() => {})

  // Honor explicit `data-waitfor` markers.
  const waitfors = slide.locator('[data-waitfor]')
  const waitforCount = await waitfors.count().catch(() => 0)
  for (let i = 0; i < waitforCount; i++) {
    const el = waitfors.nth(i)
    const sel = await el.getAttribute('data-waitfor').catch(() => null)
    if (sel)
      await el.locator(sel).waitFor({ state: 'visible', timeout }).catch(() => {})
  }

  // Wait for embedded frames to load.
  await Promise.all(page.frames().map(f => f.waitForLoadState(undefined, { timeout }).catch(() => {})))

  // Wait for Mermaid graphs, then hide the offscreen render container.
  const mermaid = slide.locator('#mermaid-rendering-container')
  if (await mermaid.count().catch(() => 0) > 0) {
    for (;;) {
      const el = mermaid.locator('div').first()
      if (await el.count().catch(() => 0) === 0)
        break
      await el.waitFor({ state: 'detached', timeout }).catch(() => {})
    }
    await mermaid.evaluate(node => (node as HTMLElement).style.display = 'none').catch(() => {})
  }
}

/**
 * Build the print-mode URL for a single slide at a click step.
 *
 * `print=clicks` (not `print=true`) is essential: `SlidesShow.vue` renders
 * `isPrintMode && !isPrintWithClicks ? createFixedClicks(route, CLICKS_MAX)
 * : getPrimaryClicks(route)`, so plain `print=true` force-reveals every click
 * step and ignores the `clicks` query. `print=clicks` keeps the primary clicks
 * context, which honors `clicks` and reports a real `clicksTotal`.
 *
 * `range` limits the slides mounted in print mode to just this one, which keeps
 * the render cheap and stops other slides' errors leaking into the report.
 *
 * Exported for tests.
 *
 * @internal
 */
export function printUrl(serverUrl: string, no: number, clicks: number): string {
  const query = new URLSearchParams({ print: 'clicks', range: String(no) })
  if (clicks > 0)
    query.set('clicks', String(clicks))
  return joinUrl(serverUrl, `${no}?${query}`)
}

/**
 * Read the client's clicks state for the rendered slide. The client clamps the
 * requested click to `[clicksStart, total]`, so `current` is what is actually
 * shown.
 */
async function readClicksState(page: Page): Promise<{ total: number, current: number }> {
  return page.evaluate(() => {
    // @ts-expect-error injected in dev
    const nav = window.__slidev__?.nav
    return {
      total: (nav?.clicksTotal as number | undefined) ?? 0,
      current: (nav?.clicks as number | undefined) ?? 0,
    }
  }).catch(() => ({ total: 0, current: 0 }))
}

/** Screenshot a single slide at a given click step and color scheme. */
export async function screenshotSlide(opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const browser = await getBrowser()
  const context = await newSlideContext(browser, {
    width: opts.width,
    height: opts.height,
    dark: !!opts.dark,
    scale: opts.scale,
  })
  const page = await context.newPage()
  const errors = attachErrorCollector(page)
  try {
    await navigateAndWait(page, printUrl(opts.serverUrl, opts.no, opts.clicks ?? 0), opts.no, opts)
    const { total, current } = await readClicksState(page)
    errors.push(...await readViteOverlay(page))
    const buffer = await page.screenshot({ type: 'png' })
    return {
      buffer,
      clicksTotal: total,
      clicksShown: current,
      errors: dedupeErrors(errors),
    }
  }
  finally {
    await context.close().catch(() => {})
    scheduleIdleClose()
  }
}

/** Load a slide headlessly and report any compilation/runtime errors. */
export async function collectSlideErrors(opts: CollectErrorsOptions): Promise<CapturedError[]> {
  const browser = await getBrowser()
  const context = await newSlideContext(browser, {
    width: opts.width,
    height: opts.height,
    dark: !!opts.dark,
  })
  const page = await context.newPage()
  const errors = attachErrorCollector(page)
  try {
    await navigateAndWait(page, printUrl(opts.serverUrl, opts.no, 0), opts.no, opts)
    errors.push(...await readViteOverlay(page))
    return dedupeErrors(errors)
  }
  finally {
    await context.close().catch(() => {})
    scheduleIdleClose()
  }
}
