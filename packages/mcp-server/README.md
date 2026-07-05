# @justanotetaker/mcp-server

A local **stdio MCP server** that lets any Claude agent (Claude Code, Desktop,
etc.) pipe notes onto your Just a Notetaker canvas — drop research, plans, or
task lists onto a board mid-task.

It authenticates with a **personal API token** (`jnt_…`) and talks to the
deployed API over HTTPS, exposing three tools:

| Tool | What it does |
|------|--------------|
| `list_boards` | List your canvases (id, name, view mode). |
| `create_note` | Create a markdown note on a board (headings, `- [ ]` tasks, `**bold**`, links, `![](img)`, …). Board by name or id; `x`/`y` optional. |
| `search_notes` | Full-text search across your notes. |

## 1. Mint a token

Sign into the app, open the browser console, and run:

```js
await fetch("/api/tokens", {
  method: "POST",
  headers: { "content-type": "application/json" },
  credentials: "include",
  body: JSON.stringify({ name: "claude-code" }),
}).then((r) => r.json());
```

Copy the `secret` (`jnt_…`) — it's shown **once**. (A settings-panel UI for
this is a planned follow-up.)

## 2. Build

```sh
pnpm --filter @justanotetaker/mcp-server build
```

## 3. Register with your MCP client

Add to your MCP config (e.g. `.mcp.json` for Claude Code, or the Desktop config):

```jsonc
{
  "mcpServers": {
    "justanotetaker": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/index.js"],
      "env": {
        "JUSTNOTE_TOKEN": "jnt_…",
        "JUSTNOTE_API_URL": "https://api.justanotetaker.kreativekorna.com"
      }
    }
  }
}
```

Then ask your agent to "drop this on my *Research* board" and it lands as a
note. New notes are placed at a random open-ish spot — rearrange on the canvas.

## Env

- `JUSTNOTE_TOKEN` (required) — your `jnt_…` personal token.
- `JUSTNOTE_API_URL` (optional) — defaults to the hosted API.
