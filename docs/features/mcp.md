---
relates:
  - guide/work-with-ai
  - Model Context Protocol: https://modelcontextprotocol.io/
  - features/vscode-extension
since: v52.17.0
tags: [editor, tool]
description: |
  Built-in MCP server that lets AI agents inspect, edit, reorder, and navigate your slides.
---

# MCP Server

Slidev ships a built-in [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, so any MCP-capable AI agent (Claude Code, Codex, Cursor, VS Code Copilot, etc.) can work with your slides through structured tools instead of raw text edits — reading slides, updating content and notes, inserting/removing/reordering slides, and even driving the live presentation.

## Via the Dev Server

When the dev server is running, the MCP server is available over HTTP (streamable transport) at:

```
http://localhost:<port>/__mcp
```

For example, register it with your agent:

::: code-group

```bash [Claude Code]
claude mcp add --transport http slidev http://localhost:3030/__mcp
```

```json [VS Code / Cursor]
{
  "mcpServers": {
    "slidev": {
      "type": "http",
      "url": "http://localhost:3030/__mcp"
    }
  }
}
```

:::

With the dev server connected, agents can also use the `slidev-goto-slide` tool to navigate all connected browsers to a slide — handy for visually verifying a slide right after editing it. Edits made through the MCP tools are written back to your markdown files and hot-reloaded instantly.

### Visual verification & error checking

When the dev server is running (and [`playwright-chromium`](https://npmjs.com/package/playwright-chromium) is installed, the same optional dependency used for [exporting](../guide/exporting)), two extra tools let an agent _see_ and _validate_ its own changes instead of editing blind:

- `slidev-screenshot` renders a slide with a headless browser and returns it as a **PNG image** the agent can look at. You can target a specific click-animation step (`clicks`) and choose `light` (default) or `dark` mode (`theme`). The response also reports the slide's total click steps and any errors seen while rendering.
- `slidev-get-errors` loads a slide headlessly and reports **compilation errors** (Vite/Vue transform failures shown in the dev error overlay, with file, line, and code frame) plus runtime console/page errors — so an agent can confirm the deck still compiles after an edit. Benign browser noise (missing resources, wake-lock denials, etc.) is filtered out.

The headless browser is launched lazily on first use and reused across calls, then closed after a short idle period and when the dev server shuts down. These tools require a running dev server; they are not available over stdio.

To disable the endpoint, set in your headmatter:

```yaml
---
mcp: false
---
```

## Via Stdio

Without a dev server, you can start a standalone MCP server over stdio, operating directly on the markdown files:

```bash
slidev mcp [entry]
```

For example:

```json
{
  "mcpServers": {
    "slidev": {
      "command": "npx",
      "args": ["slidev", "mcp", "slides.md"]
    }
  }
}
```

## Available Tools

| Tool                  | Description                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `slidev-get-info`     | Deck overview: entry file, title, slide count, markdown files, dev server URL and current position |
| `slidev-list-slides`  | List all slides with number, title, layout, and source file                                        |
| `slidev-get-slide`    | Full source of one slide: frontmatter, content, note, and source line range                        |
| `slidev-update-slide` | Update the content, note, and/or frontmatter of a slide                                            |
| `slidev-insert-slide` | Insert a new slide after an existing one                                                           |
| `slidev-remove-slide` | Remove a slide                                                                                     |
| `slidev-move-slide`   | Move a slide before/after another one to reorder the deck                                          |
| `slidev-goto-slide`   | Navigate the live presentation to a slide (dev server only)                                        |
| `slidev-screenshot`   | Render a slide to a PNG image at a given click step and light/dark theme (dev server only)         |
| `slidev-get-errors`   | Report compilation/runtime errors for a slide (dev server only)                                    |

Slides are addressed by their rendered 1-based number, matching the slide numbers shown in the presentation.
