# @codellyson/justanotetaker-mcp

A local **stdio MCP server** that lets any MCP client (Claude Code, Claude
Desktop, etc.) work with your Just a Notetaker canvas — drop research, plans,
or task lists onto a board mid-task, reorganize notes, and drive agent task
cards.

It authenticates with a **personal API token** (`jnt_…`) and talks to the
deployed API over HTTPS, exposing:

| Tool | What it does |
|------|--------------|
| `list_boards` | List your canvases (id, name). |
| `create_board` | Create a new board. |
| `rename_board` | Rename a board. |
| `delete_board` | Delete a board and its notes (restorable in-app for 30 days). |
| `create_note` | Create a markdown note on a board (headings, `- [ ]` tasks, `**bold**`, links, `![](img)`, …). Board by name or id; `x`/`y` optional. |
| `list_notes` | List a board's notes with ids/positions/text (source of ids for update/delete). |
| `update_note` | Update a note's text, position, or kind by id. |
| `delete_note` | Delete a note by id (restorable in-app for 30 days). |
| `create_task` | Create a task card (agent job) with a queued status. |
| `update_task` | Update a task card's status (running / done + result / error). |
| `search_notes` | Full-text search across your notes. |

## 1. Mint a token

In the app, open the command palette (`⌘K` / `Ctrl-K`), run **API tokens**,
name the token, and hit **Create**. Copy the `jnt_…` secret — it's shown
**once** and can't be retrieved again. Revoke tokens from the same panel.

## 2. Register with your MCP client

Add to your MCP config (e.g. `.mcp.json` for Claude Code, or the Desktop config):

```jsonc
{
  "mcpServers": {
    "justanotetaker": {
      "command": "npx",
      "args": ["-y", "@codellyson/justanotetaker-mcp"],
      "env": {
        "JUSTNOTE_TOKEN": "jnt_…",
        "JUSTNOTE_API_URL": "https://api.justanotetaker.kreativekorna.com"
      }
    }
  }
}
```

(Working from the repo instead? `pnpm --filter @codellyson/justanotetaker-mcp build`
and point `command` at `node <repo>/packages/mcp-server/dist/index.js`.)

Then ask your agent to "drop this on my *Research* board" and it lands as a
note. New notes are placed at a random open-ish spot — rearrange on the canvas.

## Env

- `JUSTNOTE_TOKEN` (required) — your `jnt_…` personal token.
- `JUSTNOTE_API_URL` (optional) — defaults to the hosted API.
