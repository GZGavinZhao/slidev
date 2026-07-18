# Plan 026: MCP visual verification — `slidev-screenshot` + `slidev-get-errors`

> **Status: DONE.** Implemented and verified end-to-end against a live dev
> server (`demo/starter`). This file documents the change as a handoff/record;
> re-read it before modifying the MCP render path.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (adds a headless-browser dependency path to the dev server)
- **Depends on**: none
- **Category**: feature (agent DX)

## Why this matters

The built-in MCP server (`packages/slidev/node/mcp/server.ts`) lets agents read
and edit slide *source*, and `slidev-goto-slide` drives the human's browser —
but the agent itself can never *see* the rendered result, nor tell whether an
edit compiles. So agents edit Slidev decks blind and rely on the user to relay
"that looks wrong". This adds the two missing feedback channels:

1. **See a slide**: `slidev-screenshot` returns a PNG (MCP image content) of any
   slide at any click step, in light or dark mode.
2. **Know it compiles**: `slidev-get-errors` reports Vite/Vue compile errors and
   runtime console/page errors for a slide.

It also enriches `slidev-get-slide` with the slide's source line range.

## What was implemented

### `packages/slidev/node/mcp/render.ts` (new)

Headless rendering used only by the dev-server MCP. Key decisions:

- **Reuses the export renderer's Playwright resolver** (`importPlaywright`,
  newly `export`ed from `commands/export.ts`) but does **not** refactor
  `export.ts` (that god function is gated behind plans 022/023). The
  slide-ready wait logic is deliberately duplicated (small, and keeps the
  test-gated export path untouched).
- **Browser is cached** at module scope and reused across (stateless) MCP HTTP
  requests, closed after 60s idle and on dev-server shutdown
  (`closeRenderBrowser`, wired in `vite/mcp.ts`).
- **Screenshots use per-slide print mode with clicks** (`/{no}?print=clicks&range={no}`).
  The one-piece `/print` route is export-mode only (`__SLIDEV_FEATURE_PRINT__` is
  false in dev), but the `play` route honors `?print` (`useNav.isPrintMode =
  query.has('print')`), giving a clean, transition-free single-slide frame.
  `print=clicks` (rather than `print=true`) is **required**: `SlidesShow.vue`
  renders `isPrintMode && !isPrintWithClicks ? createFixedClicks(route,
  CLICKS_MAX) : getPrimaryClicks(route)`, so `print=true` force-reveals every
  click step and ignores the `clicks` query. `range={no}` limits the mounted
  slides to the target one, keeping renders cheap and isolating its errors.
- **`clicksTotal`/`clicksShown` are read from `window.__slidev__.nav`** after the
  render. Because `print=clicks` keeps the primary clicks context, both values
  are correct from a single navigation, and the client's own clamping to
  `[clicksStart, total]` is what gets reported (no server-side clamping math).
- **Dark mode**: sets `localStorage['slidev-color-schema']` via `addInitScript`
  *and* `emulateMedia({ colorScheme })`. This wins when the deck's `colorSchema`
  is `auto` (default); a deck that hard-codes `colorSchema` keeps its setting
  (same limitation as export).
- **Error capture**: `console` (error level) + `pageerror` events + the Vite
  error overlay (`vite-error-overlay` shadow DOM: file + message + code frame).
  A `BENIGN_ERROR_PATTERNS` denylist filters non-compile noise (wake-lock
  denials, `net::ERR_*`/`ERR_CERT` resource failures, favicon, devtools hints).
  Results are de-duplicated.

### `packages/slidev/node/mcp/server.ts`

- `SlidevMcpContext` gained an optional `render` capability (`screenshot`,
  `collectErrors`) so `server.ts` stays transport-agnostic and playwright-free
  (type-only import of `render.ts`). Stdio mode does not set it.
- New tools `slidev-screenshot` (returns `{ image, text }`) and
  `slidev-get-errors`, both registered only when `ctx.render` is present.
- `slidev-get-slide` now also returns `startLine` / `contentStartLine` /
  `endLine` (1-based, from `SourceSlideInfo.start`/`contentStart`/`end`).

### `packages/slidev/node/vite/mcp.ts`

- Builds `ctx.render` from the running server URL + `config.canvasWidth`/
  `aspectRatio`, and closes the browser on `httpServer` `close`.

## Verification performed

- `pnpm --filter @slidev/cli build`, `vue-tsc --noEmit`, and `eslint` all clean.
- `test/mcp.test.ts` covers the render tools with a fake `render` capability (no
  browser needed): tool registration is gated on `ctx.render`, the screenshot
  result carries `image/png` content plus a summary, clicks are clamped, light
  is the default theme, out-of-range slides error before rendering, and
  `get-errors` defaults to the live slide. It also asserts the new
  `startLine`/`contentStartLine` values.
- End-to-end against `demo/starter` over `/__mcp`:
  - `slidev-get-slide` returns correct line ranges.
  - `slidev-screenshot` returns a valid PNG; `clicksTotal` matches the deck
    (e.g. slide 6 → 8), `clicks` is clamped (99 → 8), dark mode renders dark.
  - `slidev-get-errors` reports "no errors" on the clean deck, and on a slide
    with an injected invalid Vue expression reports the Vite overlay error with
    file, line, and code frame, with browser noise filtered and duplicates
    collapsed.

### MCP SDK v2

This change was rebased onto the SDK v2 migration (`@modelcontextprotocol/sdk`
→ `@modelcontextprotocol/server`/`node`/`client`). The render tools follow the
v2 conventions: `inputSchema` is a `z.object(...)` rather than a raw shape.
Image content (`{ type: 'image', data, mimeType }`) is unchanged in v2 and was
re-verified over the `NodeStreamableHTTPServerTransport` HTTP endpoint.

## Follow-ups (not done)

- If plans 022/023 land, fold the duplicated slide-ready wait in `render.ts`
  into a shared helper extracted from `export.ts`.
- Optional: an MCP resource/tool to screenshot the whole deck (overview) in one
  call.

## Fix log

- **Click steps were ignored (fixed).** The first implementation used
  `?print=true`, which makes the client force-reveal all clicks, so every
  requested click step produced the same fully-revealed frame and `clicksTotal`
  read 0 (worked around with an extra play-mode navigation). Switched to
  `?print=clicks&range={no}`, which honors `clicks`, reports a real
  `clicksTotal`, and removed the two-navigation workaround. Guarded by the
  `mcp render urls` tests in `test/mcp.test.ts`.
- Note for future debugging: `v-mark`/rough-notation draws with randomized
  hand-drawn geometry, so two screenshots of the same click step are not
  byte-identical. Compare rendered content, not PNG hashes.
