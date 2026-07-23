# Connect your notes to any AI agent (MCP)

Just a Notetaker ships a small **MCP server** — a bridge that lets any
MCP-capable AI agent (Claude Code, Claude Desktop, and other MCP clients) read
and write notes on your canvas while it works.

Instead of copy-pasting an assistant's output into your notes by hand, you point
it at a board and it drops the note there itself — a plan, a research summary, a
task list — right where you'll see it next time you open the app.

It's local, it's yours, and it's gated by a personal token you create and can
revoke at any time.

---

## What you can do with it

Once it's connected, you can ask your agent things like:

- *"Summarize this thread and put it on my **Research** board."*
- *"Turn these requirements into a checklist and drop it on **Project X**."*
- *"What have I already written about pricing?"* → it searches your notes.
- *"Save this SQL snippet to **Snippets** so I don't lose it."*
- *"Which canvases do I have?"* → it lists your boards.

The agent does the work; the note lands on your canvas as normal markdown you
can move, edit, and search like anything else you wrote yourself.

### Real use cases

| You're doing… | …and the agent can |
|---|---|
| Research in Claude | Drop each finding as its own note on a *Research* board as it goes |
| Planning a feature | Write the plan as a task list (`- [ ]`) you can tick off on the canvas |
| Debugging | Save the working fix + context to a *Snippets* board for next time |
| Reviewing your own notes | Search everything you've written and cite the relevant note |
| Clearing your head | Capture a brain-dump into a *Inbox* board mid-conversation |

Because notes are stored as plain markdown, everything the agent writes —
headings, checkboxes, code blocks, links, images — renders exactly the same as
notes you type yourself, and is instantly full-text searchable.

---

## The tools

The server exposes the full board/note lifecycle plus search and the
conversation tools. An agent picks whichever it needs.

### `list_boards`
Lists your canvases so the agent knows where notes can go. Returns each board's
`id` and `name`.

> *"Which boards do I have?"* → `Research`, `Project X`, `Inbox`, …

### `create_board` / `rename_board` / `delete_board`
Board management. `create_board` takes a `name`; `rename_board` and
`delete_board` take a board **name or id**. Deleting a board soft-deletes it
and every note on it — notes are restorable from the app's recently-deleted
panel for 30 days.

> *"Make me a board called Q3 planning."* → a fresh canvas appears in the app.

### `create_note`
Creates a note on a board. The body is **markdown** and supports everything the
app renders:

- `# / ## / ###` headings
- `- ` bullets, `1. ` ordered lists
- `- [ ]` / `- [x]` task checkboxes
- `**bold**`, `*italic*`, `` `code` ``, ` ```fenced code``` `
- `[links](https://…)` and images `![alt](https://…)`

| Input | Required | Notes |
|---|---|---|
| `board` | yes | Board **name or id** (from `list_boards`) |
| `text` | yes | The note body, in markdown |
| `x`, `y` | no | Canvas coordinates; omit to drop it at an open-ish spot |

> *"Put a checklist of the release steps on Project X."* → a task-list note
> appears on that board.

### `list_notes`
Lists a board's notes with their `id`, position, kind, and full text — the way
an agent finds the note it wants to edit or delete.

### `update_note`
Updates a note by `id`: replace its `text` (markdown), move it (`x`/`y`), or
switch its `kind` between `card` (compact sticky) and `page` (document
surface).

> *"Tick off the second item on my release checklist."* → the agent reads the
> note with `list_notes`, rewrites the line, and `update_note`s it.

### `delete_note`
Deletes a note by `id`. Soft-delete — restorable from the app's
recently-deleted panel for 30 days.

### `search_notes`
Full-text search across **all** your notes. Returns matches with a short
highlighted snippet, so the agent can find and quote what you've already
written.

> *"What did I note about auth last week?"* → matching notes with snippets.

---

## Setup

### 1. Mint a personal token

In the app, open the command palette (**⌘K** / **Ctrl-K**), run **API tokens**,
give the token a name, and hit **Create**.

Copy the `jnt_…` secret immediately — it's shown **once** and can't be
retrieved again. You can revoke any token from the same panel at any time,
which instantly cuts off whatever was using it.

### 2. Register it with your agent

The server is published as
[`@codellyson/justanotetaker-mcp`](https://www.npmjs.com/package/@codellyson/justanotetaker-mcp),
so no checkout or build is needed. Add it to your MCP client config —
`.mcp.json` for Claude Code, or the Claude Desktop config file:

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

(Working from the repo instead: `pnpm --filter @codellyson/justanotetaker-mcp build`
and point `command` at `node <repo>/packages/mcp-server/dist/index.js`.)

Restart the agent, and it will discover the tools. Now just talk to it:
*"drop this on my Research board."*

---

## Configuration

| Env var | Required | Default |
|---|---|---|
| `JUSTNOTE_TOKEN` | yes | — (your `jnt_…` token) |
| `JUSTNOTE_API_URL` | no | `https://api.justanotetaker.kreativekorna.com` |
| `JUSTNOTE_WATCH_INTERVAL` | no | `3000` (watch-mode poll, ms) |
| `JUSTNOTE_WATCH_MODEL` | no | — (model for watch-mode replies) |
| `JUSTNOTE_CLAUDE_BIN` | no | `claude` (CLI to drive in watch mode) |

Point `JUSTNOTE_API_URL` at your own deployment if you self-host the API.

---

## Live agent sessions (watch mode)

The MCP tools are **pull-only** — the agent replies only when *you* prompt it,
so a note you drop in the composer just sits there until something pokes the
agent. Watch mode is that poke: it turns a board into a live back-and-forth.

```sh
# PowerShell (Windows: set JUSTNOTE_CLAUDE_BIN to the full claude.exe path —
# the CLI isn't resolvable as a bare command outside PowerShell)
$env:JUSTNOTE_TOKEN="jnt_…"; $env:JUSTNOTE_API_URL="http://localhost:8787"
$env:JUSTNOTE_CLAUDE_BIN="$HOME\.local\bin\claude.exe"
node packages/mcp-server/dist/index.js watch "Agent"
```

It polls the board; when your latest note is an unanswered turn, it runs your
local `claude` CLI **headless** (`claude -p`) to write a reply and posts it back
as an agent note. That means:

- **No API key** — it uses your existing Claude Code sign-in, same as the CLI.
- Replies land on the canvas on their own — type in the composer, the answer
  appears below it a few seconds later.
- `--strict-mcp-config` keeps that headless run from re-loading this MCP server,
  so it just writes text; the watcher owns the posting.

Leave it running in a terminal for as long as you want the board to be live;
`Ctrl+C` stops it. Set `JUSTNOTE_WATCH_MODEL` to pin a specific model.

### In the desktop app

The desktop build manages this for you — no terminal. Open a board and hit the
**agent-session** button in the toolbar to mark it live; the app runs the same
watch loop in-process, reusing your signed-in session (no token to set) and your
local `claude` install, and answers new turns on every board you've marked.
Click again to stop. It looks for `claude` at the default install path, or set
`JUSTNOTE_CLAUDE_BIN` if yours lives elsewhere.

---

## How it works (for the curious)

- It's a **stdio** MCP server — the agent launches it as a subprocess and talks
  over stdin/stdout. Nothing listens on a network port.
- Every call is an authenticated HTTPS request to the Just a Notetaker API,
  carrying your token as a `Bearer` credential — the same API the web and
  desktop apps use.
- The token scopes access to **your** account only. It sees the notes and
  boards you'd see when signed in — nothing else.

## Security & privacy

- **The token is a credential.** Treat it like a password. Anyone with it can
  read and write your notes (but not change your account or password).
- It's shown **once** at creation and stored only as a hash on the server; the
  panel keeps a short prefix so you can tell tokens apart.
- **Revoke instantly** from the API tokens panel if a token leaks or you're done
  with it.
- The server talks only to the API URL you configure and sends nothing
  anywhere else.

## Troubleshooting

- **`JUSTNOTE_TOKEN is required`** on startup — the env var isn't set in your
  MCP config. Add it under `env`.
- **`… → 401`** — the token is wrong or was revoked; mint a fresh one.
- **`No board matching "…"`** — the name/id doesn't match; run `list_boards`
  first (matching is case-insensitive on the name).
- **Agent doesn't see the tools** — rebuild (`pnpm --filter
  @justanotetaker/mcp-server build`) and fully restart the agent so it
  re-launches the subprocess.
