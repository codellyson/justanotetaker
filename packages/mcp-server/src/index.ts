#!/usr/bin/env node
// A local stdio MCP server that lets any Claude agent pipe notes onto a
// Just a Notetaker canvas. Auth is a personal API token (jnt_…) minted in the
// app; set it via env. Add to your MCP client config, e.g.:
//
//   {
//     "command": "node",
//     "args": ["<repo>/packages/mcp-server/dist/index.js"],
//     "env": {
//       "JUSTNOTE_TOKEN": "jnt_…",
//       "JUSTNOTE_API_URL": "https://api.justanotetaker.kreativekorna.com"
//     }
//   }
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.JUSTNOTE_API_URL ?? "https://api.justanotetaker.kreativekorna.com").replace(/\/$/, "");
const TOKEN = process.env.JUSTNOTE_TOKEN;

if (!TOKEN) {
  console.error("[justanotetaker-mcp] JUSTNOTE_TOKEN is required — mint a personal token (jnt_…) in the app.");
  process.exit(1);
}

type Board = { id: string; name: string; sort: number };

type ApiNote = {
  id: string;
  x: number;
  y: number;
  t: number;
  text: string;
  kind: string;
  color: string | null;
  parentId?: string | null;
  meta?: Record<string, unknown> | null;
};

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}${body ? ` ${body}` : ""}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

async function resolveBoard(ref: string): Promise<Board> {
  const { boards } = await api<{ boards: Board[] }>("/api/boards");
  const found = boards.find((b) => b.id === ref || b.name.toLowerCase() === ref.toLowerCase());
  if (!found) {
    throw new Error(`No board matching "${ref}". Available: ${boards.map((b) => b.name).join(", ") || "(none)"}`);
  }
  return found;
}

const server = new McpServer({ name: "justanotetaker", version: "0.4.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

server.registerTool(
  "list_boards",
  {
    description: "List your Just a Notetaker canvases (boards): id and name.",
    inputSchema: {},
  },
  async () => {
    const { boards } = await api<{ boards: Board[] }>("/api/boards");
    return text(JSON.stringify(boards, null, 2));
  },
);

server.registerTool(
  "create_board",
  {
    description: "Create a new board (canvas).",
    inputSchema: { name: z.string().min(1).describe("Board name") },
  },
  async ({ name }) => {
    const { board } = await api<{ board: Board }>("/api/boards", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return text(`Created board "${board.name}" (${board.id}).`);
  },
);

server.registerTool(
  "rename_board",
  {
    description: "Rename a board.",
    inputSchema: {
      board: z.string().describe("Current board name or id (see list_boards)"),
      name: z.string().min(1).describe("New name"),
    },
  },
  async ({ board, name }) => {
    const b = await resolveBoard(board);
    await api(`/api/boards/${encodeURIComponent(b.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    return text(`Renamed "${b.name}" → "${name}".`);
  },
);

server.registerTool(
  "delete_board",
  {
    description:
      "Delete a board. Destructive: the board and every note on it move to " +
      "recently-deleted (notes are restorable in the app for 30 days). Ask the " +
      "user before deleting anything you did not just create.",
    inputSchema: { board: z.string().describe("Board name or id (see list_boards)") },
  },
  async ({ board }) => {
    const b = await resolveBoard(board);
    await api(`/api/boards/${encodeURIComponent(b.id)}`, { method: "DELETE" });
    return text(`Deleted board "${b.name}" and its notes (restorable for 30 days).`);
  },
);

server.registerTool(
  "create_note",
  {
    description:
      "Create a note on a board. Text supports markdown: # headings, - bullets, " +
      "1. ordered, `- [ ]` task checkboxes, **bold**, *italic*, `code`, [links](url), " +
      "and images via ![alt](url). Pass the board by name or id. x/y are optional " +
      "canvas coordinates; omit to drop it at a random open-ish spot.",
    inputSchema: {
      board: z.string().describe("Board name or id (see list_boards)"),
      text: z.string().describe("Note body (markdown)"),
      x: z.number().optional().describe("Canvas x (optional)"),
      y: z.number().optional().describe("Canvas y (optional)"),
    },
  },
  async ({ board, text, x, y }) => {
    const b = await resolveBoard(board);
    const pos = {
      x: x ?? Math.round(Math.random() * 1200 - 200),
      y: y ?? Math.round(Math.random() * 700 - 100),
    };
    const { note } = await api<{ note?: { id?: string } }>("/api/notes", {
      method: "POST",
      body: JSON.stringify({ boardId: b.id, x: pos.x, y: pos.y, t: Date.now(), text }),
    });
    return { content: [{ type: "text", text: `Created note${note?.id ? ` ${note.id}` : ""} on "${b.name}".` }] };
  },
);

server.registerTool(
  "list_notes",
  {
    description:
      "List a board's notes with their ids, positions, and text — use this to " +
      "find the note id for update_note / delete_note.",
    inputSchema: { board: z.string().describe("Board name or id (see list_boards)") },
  },
  async ({ board }) => {
    const b = await resolveBoard(board);
    const notes = await boardNotes(b.id);
    const out = notes.map((n) => ({ id: n.id, x: n.x, y: n.y, t: n.t, kind: n.kind, text: n.text, parentId: n.parentId ?? null }));
    return text(JSON.stringify({ board: b.name, notes: out }, null, 2));
  },
);

server.registerTool(
  "update_note",
  {
    description:
      "Update an existing note by id (get ids from list_notes or search_notes). " +
      "Any combination of: text (markdown, replaces the whole body), x/y position, " +
      "kind ('card' = compact sticky, 'page' = full document surface).",
    inputSchema: {
      id: z.string().describe("Note id"),
      text: z.string().optional().describe("New note body (markdown) — replaces the old text"),
      x: z.number().optional().describe("New canvas x"),
      y: z.number().optional().describe("New canvas y"),
      kind: z.enum(["card", "page"]).optional().describe("Note kind"),
    },
  },
  async ({ id, text: body, x, y, kind }) => {
    const patch: Record<string, unknown> = {};
    if (body !== undefined) { patch.text = body; patch.t = Date.now(); }
    if (x !== undefined) patch.x = x;
    if (y !== undefined) patch.y = y;
    if (kind !== undefined) patch.kind = kind;
    if (Object.keys(patch).length === 0) throw new Error("Nothing to update — pass text, x, y, or kind.");
    await api(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return text(`Updated note ${id}.`);
  },
);

server.registerTool(
  "delete_note",
  {
    description:
      "Delete a note by id (get ids from list_notes or search_notes). The note " +
      "moves to recently-deleted and is restorable in the app for 30 days. Ask " +
      "the user before deleting anything you did not just create.",
    inputSchema: { id: z.string().describe("Note id") },
  },
  async ({ id }) => {
    await api(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
    return text(`Deleted note ${id} (restorable for 30 days).`);
  },
);

server.registerTool(
  "create_task",
  {
    description:
      "Create a task card on a board — a live agent job with a status " +
      "lifecycle (queued → running → done/error). Use this when you're about " +
      "to do a multi-step piece of work and want a visible marker of it on the " +
      "canvas; then call update_task as you progress. The card shows the prompt " +
      "and, when done, the result you write back.",
    inputSchema: {
      board: z.string().describe("Board name or id (see list_boards)"),
      prompt: z.string().describe("What the task is — the work to be done"),
      title: z.string().optional().describe("Short title (defaults to the prompt's first line)"),
      x: z.number().optional().describe("Canvas x (optional)"),
      y: z.number().optional().describe("Canvas y (optional)"),
    },
  },
  async ({ board, prompt, title, x, y }) => {
    const b = await resolveBoard(board);
    const pos = {
      x: x ?? Math.round(Math.random() * 1200 - 200),
      y: y ?? Math.round(Math.random() * 700 - 100),
    };
    const { note } = await api<{ note?: { id?: string } }>("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        boardId: b.id,
        x: pos.x,
        y: pos.y,
        t: Date.now(),
        kind: "task",
        text: title ?? prompt.split("\n")[0].slice(0, 120),
        meta: { status: "queued", prompt },
      }),
    });
    return text(`Created task ${note?.id ?? ""} on "${b.name}" (queued).`);
  },
);

server.registerTool(
  "update_task",
  {
    description:
      "Update a task card's status by id (from create_task or list_notes). " +
      "Set status to running when you start, done with a `result` (markdown, " +
      "shown on the card and full-text searchable) when finished, or error with " +
      "an `error` message if it failed.",
    inputSchema: {
      id: z.string().describe("Task card note id"),
      status: z.enum(["queued", "running", "done", "error"]).describe("New status"),
      result: z.string().optional().describe("Result markdown (on done — replaces the card body)"),
      error: z.string().optional().describe("Error message (on error)"),
    },
  },
  async ({ id, status, result, error }) => {
    const { note } = await api<{ note: ApiNote }>(`/api/notes/by-id/${encodeURIComponent(id)}`);
    const prev = (note.meta ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const meta: Record<string, unknown> = { ...prev, status };
    if (status === "running") meta.startedAt = now;
    if (status === "done" || status === "error") meta.finishedAt = now;
    if (error !== undefined) meta.error = error;
    const patch: Record<string, unknown> = { meta };
    if (status === "done" && result !== undefined) { patch.text = result; patch.t = now; }
    await api(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return text(`Task ${id} → ${status}.`);
  },
);

server.registerTool(
  "search_notes",
  {
    description: "Full-text search across your notes. Returns matches with a snippet.",
    inputSchema: { query: z.string().describe("Search text") },
  },
  async ({ query }) => {
    const res = await api<{ matches: unknown[] }>(`/api/notes/search?q=${encodeURIComponent(query)}`);
    return { content: [{ type: "text", text: JSON.stringify(res.matches ?? res, null, 2) }] };
  },
);

async function boardNotes(boardId: string): Promise<ApiNote[]> {
  const { notes } = await api<{ notes: ApiNote[] }>(`/api/notes?board=${encodeURIComponent(boardId)}`);
  return [...notes].sort((a, b) => a.t - b.t);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[justanotetaker-mcp] connected → ${API_URL}`);
