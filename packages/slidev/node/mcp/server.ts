import type { Awaitable } from '@antfu/utils'
import type { LoadedSlidevData } from '@slidev/parser/fs'
import type { SlideInfo, SlidevConfig } from '@slidev/types'
import type { CapturedError, ScreenshotResult } from './render'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { applySlidePatch, insertSlide, moveSlide, removeSlide, resolveSlide } from './operations'

export type SlidevMcpData = LoadedSlidevData & { config?: SlidevConfig }

export interface SlidevMcpNav {
  /** Current position of the live presentation */
  getState: () => { page: number, clicks: number }
  /** Navigate all connected clients of the live presentation */
  go: (page: number, clicks: number) => void
}

export interface SlidevMcpRender {
  /** Screenshot a slide at a click step and color scheme. */
  screenshot: (opts: { no: number, clicks: number, dark: boolean, scale?: number }) => Promise<ScreenshotResult>
  /** Load a slide headlessly and report compilation/runtime errors. */
  collectErrors: (opts: { no: number, dark: boolean }) => Promise<CapturedError[]>
}

export interface SlidevMcpContext {
  /** Slidev version */
  version: string
  /** Absolute path of the entry markdown file */
  entry: string
  /** Get the up-to-date slides data */
  getData: () => Awaitable<SlidevMcpData>
  /** URL of the running dev server, if any */
  getServerUrl?: () => string | undefined
  /** Live presentation navigation (only available with a running dev server) */
  nav?: SlidevMcpNav
  /** Headless rendering (screenshots + error capture); dev server only */
  render?: SlidevMcpRender
}

function result(data: any) {
  return {
    content: [{
      type: 'text' as const,
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  }
}

function slideSummary(slide: SlideInfo) {
  return {
    no: slide.index + 1,
    title: slide.title ?? null,
    ...slide.frontmatter.layout ? { layout: slide.frontmatter.layout } : {},
    file: slide.source.filepath,
    hasNote: !!slide.source.note,
    ...slide.importChain?.length ? { importedBySrcDirective: true } : {},
  }
}

const noSchema = z.number().int().min(1).describe('Slide number (1-based, as displayed in the presentation)')
const frontmatterSchema = z
  .record(z.string(), z.any())
  .optional()
  .describe('Slide frontmatter (YAML headmatter of the slide) as an object, e.g. { "layout": "two-cols" }')

/**
 * Create the Slidev MCP server exposing tools for agents to inspect, edit,
 * and (with a running dev server) navigate a slides deck.
 *
 * The same tool set is served over the dev server HTTP endpoint (`/__mcp`)
 * and the `slidev mcp` stdio command.
 */
export function createSlidevMcpServer(ctx: SlidevMcpContext): McpServer {
  const server = new McpServer(
    {
      name: 'slidev',
      version: ctx.version,
    },
    {
      instructions: [
        'Tools for working with a Slidev (https://sli.dev) slides deck.',
        'A deck is a Markdown file where slides are separated by `---`; each slide can have YAML frontmatter, Markdown/Vue content, and a speaker note (trailing HTML comment).',
        'Slides are addressed by their rendered 1-based number, matching the slide numbers shown in the presentation.',
        'After editing tools run, a running dev server hot-reloads the presentation automatically.',
      ].join('\n'),
    },
  )

  server.registerTool(
    'slidev-get-info',
    {
      title: 'Get deck info',
      description: 'Get an overview of the Slidev deck: entry file, title, slide count, markdown files, and (when a dev server is running) the server URL and current position of the live presentation.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await ctx.getData()
      const nav = ctx.nav?.getState()
      return result({
        slidevVersion: ctx.version,
        entry: ctx.entry,
        title: data.headmatter.title ?? data.slides[0]?.title ?? null,
        theme: data.config?.theme ?? data.headmatter.theme ?? null,
        totalSlides: data.slides.length,
        markdownFiles: Object.keys(data.markdownFiles),
        ...ctx.getServerUrl?.()
          ? {
              server: {
                url: ctx.getServerUrl(),
                // page 0 means no client has connected yet
                currentPage: nav?.page || null,
                currentClicks: nav?.page ? nav.clicks : null,
              },
            }
          : {},
      })
    },
  )

  server.registerTool(
    'slidev-list-slides',
    {
      title: 'List slides',
      description: 'List all slides of the deck with their number, title, layout, and source file. Slides hidden with `hide`/`disabled` frontmatter are not included.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await ctx.getData()
      return result(data.slides.map(slideSummary))
    },
  )

  server.registerTool(
    'slidev-get-slide',
    {
      title: 'Get slide',
      description: 'Get the full source of one slide: frontmatter, Markdown content, speaker note, and its 1-based line range in the source file.',
      inputSchema: z.object({ no: noSchema }),
      annotations: { readOnlyHint: true },
    },
    async ({ no }) => {
      const data = await ctx.getData()
      const slide = resolveSlide(data, no)
      return result({
        ...slideSummary(slide),
        // 1-based line range in the source markdown file (`file`).
        startLine: slide.source.start + 1,
        contentStartLine: slide.source.contentStart + 1,
        endLine: slide.source.end,
        frontmatter: slide.source.frontmatter,
        content: slide.source.content.trim(),
        note: slide.source.note ?? null,
        ...slide.importChain?.length
          ? { importedBy: slide.importChain.map(s => `${s.filepath}#${s.index + 1}`) }
          : {},
      })
    },
  )

  server.registerTool(
    'slidev-update-slide',
    {
      title: 'Update slide',
      description: 'Update the content, speaker note, and/or frontmatter of a slide. Only the provided fields are changed. Pass an empty string to clear the content or note. In `frontmatter`, only the given keys are patched; pass `null` as a value to delete that key.',
      inputSchema: z.object({
        no: noSchema,
        content: z.string().optional().describe('New Markdown content of the slide (without frontmatter and note)'),
        note: z.string().optional().describe('New speaker note (Markdown, stored as a trailing HTML comment)'),
        frontmatter: frontmatterSchema,
      }),
    },
    async ({ no, content, note, frontmatter }) => {
      if (content == null && note == null && frontmatter == null)
        throw new Error('Nothing to update: provide at least one of `content`, `note`, or `frontmatter`.')
      const data = await ctx.getData()
      const { slide } = await applySlidePatch(data, no, { content, note, frontmatter })
      return result(`Updated slide ${no} in ${slide.source.filepath}.`)
    },
  )

  server.registerTool(
    'slidev-insert-slide',
    {
      title: 'Insert slide',
      description: 'Insert a new slide after an existing slide (into the same markdown file). To add a slide at the very end, pass the last slide number.',
      inputSchema: z.object({
        after: z.number().int().min(1).describe('Slide number (1-based) after which the new slide is inserted'),
        content: z.string().describe('Markdown content of the new slide'),
        frontmatter: frontmatterSchema,
        note: z.string().optional().describe('Speaker note of the new slide'),
      }),
    },
    async ({ after, content, frontmatter, note }) => {
      const data = await ctx.getData()
      const { filepath } = await insertSlide(data, { after, content, frontmatter, note })
      return result(`Inserted a new slide after slide ${after} in ${filepath}. Slide numbers after it have shifted; list the slides again if needed.`)
    },
  )

  server.registerTool(
    'slidev-remove-slide',
    {
      title: 'Remove slide',
      description: 'Remove a slide from the deck (deletes it from its source markdown file).',
      inputSchema: z.object({ no: noSchema }),
      annotations: { destructiveHint: true },
    },
    async ({ no }) => {
      const data = await ctx.getData()
      const { removed, filepath } = await removeSlide(data, no)
      return result(`Removed slide ${no}${removed.title ? ` ("${removed.title}")` : ''} from ${filepath}. Slide numbers after it have shifted; list the slides again if needed.`)
    },
  )

  server.registerTool(
    'slidev-move-slide',
    {
      title: 'Move slide',
      description: 'Move a slide before or after another slide to reorder the deck. Both slides must be in the same markdown file. To swap two adjacent slides, move one after the other.',
      inputSchema: z.object({
        from: z.number().int().min(1).describe('Slide number (1-based) of the slide to move'),
        before: z.number().int().min(1).optional().describe('Move the slide right before this slide number'),
        after: z.number().int().min(1).optional().describe('Move the slide right after this slide number'),
      }),
    },
    async ({ from, before, after }) => {
      const data = await ctx.getData()
      const { filepath } = await moveSlide(data, { from, before, after })
      return result(`Moved slide ${from} ${before != null ? `before slide ${before}` : `after slide ${after}`} in ${filepath}. Slide numbers have shifted; list the slides again if needed.`)
    },
  )

  if (ctx.nav) {
    const nav = ctx.nav
    server.registerTool(
      'slidev-goto-slide',
      {
        title: 'Go to slide',
        description: 'Navigate the live presentation (all connected browsers) to a given slide, e.g. to visually verify a slide after editing it.',
        inputSchema: z.object({
          no: noSchema,
          clicks: z.number().int().min(0).optional().describe('Click animation step to reveal (defaults to 0)'),
        }),
        annotations: { idempotentHint: true },
      },
      async ({ no, clicks }) => {
        const data = await ctx.getData()
        resolveSlide(data, no) // range check
        nav.go(no, clicks ?? 0)
        return result(`Navigated the presentation to slide ${no}${clicks ? ` (click ${clicks})` : ''}.`)
      },
    )
  }

  if (ctx.render) {
    const render = ctx.render
    const themeSchema = z
      .enum(['light', 'dark'])
      .optional()
      .describe('Color scheme to render in (default "light"). Only honored when the deck\'s `colorSchema` is `auto`.')

    server.registerTool(
      'slidev-screenshot',
      {
        title: 'Screenshot slide',
        description: [
          'Render a slide with a headless browser and return a PNG image, so you can visually verify what a slide actually looks like after editing it.',
          'You can target a specific click-animation step and choose light or dark mode.',
          'The response also reports the slide\'s total click steps and any compilation/runtime errors detected while rendering.',
        ].join(' '),
        inputSchema: z.object({
          no: noSchema,
          clicks: z.number().int().min(0).optional().describe('Click animation step to reveal (0 = initial state, the default). Clamped to the slide\'s total clicks.'),
          theme: themeSchema,
          scale: z.number().min(1).max(3).optional().describe('Device scale factor for sharpness (default 1). Higher values produce larger images.'),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async ({ no, clicks, theme, scale }) => {
        const data = await ctx.getData()
        resolveSlide(data, no) // range check
        const dark = theme === 'dark'
        const shot = await render.screenshot({ no, clicks: clicks ?? 0, dark, scale })
        const summary = {
          slide: no,
          theme: dark ? 'dark' : 'light',
          clicksShown: shot.clicksShown,
          clicksTotal: shot.clicksTotal,
          ...shot.errors.length ? { errors: shot.errors } : {},
        }
        return {
          content: [
            { type: 'image' as const, data: shot.buffer.toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
          ],
        }
      },
    )

    server.registerTool(
      'slidev-get-errors',
      {
        title: 'Check for errors',
        description: [
          'Render a slide with a headless browser and report any compilation errors (Vite/Vue transform failures shown in the dev error overlay) plus runtime console/page errors.',
          'Use this after editing to confirm the deck still compiles.',
          'Note: module-scoped compile errors surface on any slide that imports the broken module, while a component error specific to one slide only shows when that slide is loaded — pass the slide you edited.',
        ].join(' '),
        inputSchema: z.object({
          no: z.number().int().min(1).optional().describe('Slide to load and check (1-based). Defaults to the live presentation\'s current slide, or slide 1.'),
          theme: themeSchema,
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ no, theme }) => {
        const data = await ctx.getData()
        const target = no ?? (ctx.nav?.getState().page || 1)
        resolveSlide(data, target) // range check
        const errors = await render.collectErrors({ no: target, dark: theme === 'dark' })
        if (!errors.length)
          return result(`No errors detected while rendering slide ${target}.`)
        return result({
          slide: target,
          errorCount: errors.length,
          errors,
        })
      },
    )
  }

  return server
}
