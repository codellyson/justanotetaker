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

type Board = { id: string; name: string; viewMode: string };

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

const server = new McpServer({ name: "justanotetaker", version: "0.1.0" });

server.registerTool(
  "list_boards",
  {
    description: "List your Just a Notetaker canvases (boards): id, name, and view mode.",
    inputSchema: {},
  },
  async () => {
    const { boards } = await api<{ boards: Board[] }>("/api/boards");
    return { content: [{ type: "text", text: JSON.stringify(boards, null, 2) }] };
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
    const note = await api<{ id?: string }>("/api/notes", {
      method: "POST",
      body: JSON.stringify({ boardId: b.id, x: pos.x, y: pos.y, t: Date.now(), text }),
    });
    return { content: [{ type: "text", text: `Created note${note?.id ? ` ${note.id}` : ""} on "${b.name}".` }] };
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[justanotetaker-mcp] connected → ${API_URL}`);
