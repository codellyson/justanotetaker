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
import { spawn } from "node:child_process";
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
  role: string | null;
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

const server = new McpServer({ name: "justanotetaker", version: "0.1.0" });

server.registerTool(
  "list_boards",
  {
    description: "List your Just a Notetaker canvases (boards): id and name.",
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

async function threadNotes(boardId: string): Promise<ApiNote[]> {
  const { notes } = await api<{ notes: ApiNote[] }>(`/api/notes?board=${encodeURIComponent(boardId)}`);
  // Chronological order = conversation order.
  return [...notes].sort((a, b) => a.t - b.t);
}

server.registerTool(
  "read_thread",
  {
    description:
      "Read a board as a two-way conversation: its notes in chronological order, each " +
      "tagged role (user | assistant), plus `needs_reply` — true when the latest note is " +
      "an unanswered user message. A note the person wrote is the user; a note you posted " +
      "with `reply` is the assistant. Call this before replying so you have the full context.",
    inputSchema: { board: z.string().describe("Board name or id (see list_boards)") },
  },
  async ({ board }) => {
    const b = await resolveBoard(board);
    const notes = await threadNotes(b.id);
    const messages = notes.map((n) => ({
      role: n.role === "assistant" ? "assistant" : "user",
      text: n.text,
    }));
    const needs_reply = messages.length > 0 && messages[messages.length - 1].role === "user";
    return {
      content: [{ type: "text", text: JSON.stringify({ board: b.name, needs_reply, messages }, null, 2) }],
    };
  },
);

server.registerTool(
  "reply",
  {
    description:
      "Post your reply to a board's conversation as a new assistant note (markdown). " +
      "It's placed below the latest note so the thread reads top-to-bottom. Read the " +
      "thread first with read_thread; only reply when it says needs_reply.",
    inputSchema: {
      board: z.string().describe("Board name or id"),
      text: z.string().describe("Your reply (markdown)"),
    },
  },
  async ({ board, text }) => {
    const b = await resolveBoard(board);
    const notes = await threadNotes(b.id);
    const last = notes[notes.length - 1];
    const x = last ? last.x : Math.round(Math.random() * 600 - 100);
    const y = last ? last.y + 320 : Math.round(Math.random() * 400);
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({ boardId: b.id, x, y, t: Date.now(), text, role: "assistant" }),
    });
    return { content: [{ type: "text", text: `Replied on "${b.name}".` }] };
  },
);

// ── Watch mode ────────────────────────────────────────────────────────────
// `justanotetaker-mcp watch <board>` turns a board into a live agent session:
// poll for a new unanswered turn, drive the local `claude` CLI headless to
// write a reply (the user's own auth — no API key), and post it back as an
// assistant note. This is the push the MCP tools can't do on their own.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = Number(process.env.JUSTNOTE_WATCH_INTERVAL ?? 3000);
const CLAUDE_BIN = process.env.JUSTNOTE_CLAUDE_BIN ?? "claude";
const CLAUDE_MODEL = process.env.JUSTNOTE_WATCH_MODEL;

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text", "--strict-mcp-config"];
    if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);
    // No shell: POSIX resolves a bare "claude" off PATH; on Windows the CLI is a
    // real .exe that cmd won't find on PATH, so point JUSTNOTE_CLAUDE_BIN at its
    // full path. The prompt goes in via stdin, never the argv.
    const child = spawn(CLAUDE_BIN, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude exited ${code}${err ? `: ${err.trim()}` : ""}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPrompt(boardName: string, messages: { role: string; text: string }[]): string {
  const transcript = messages
    .map((m) => `[${m.role === "assistant" ? "you" : "them"}]: ${m.text}`)
    .join("\n\n");
  return [
    `You are replying inside "${boardName}", a spatial note board someone is using as a chat with you.`,
    `The conversation so far is below, oldest first. Write a helpful reply to their most recent message.`,
    `Respond in GitHub-flavored markdown. Output only your reply — no preamble, no sign-off.`,
    ``,
    transcript,
  ].join("\n");
}

async function postAssistantNote(board: Board, text: string) {
  const notes = await threadNotes(board.id);
  const last = notes[notes.length - 1];
  const x = last ? last.x : 0;
  const y = last ? last.y + 320 : 0;
  await api("/api/notes", {
    method: "POST",
    body: JSON.stringify({ boardId: board.id, x, y, t: Date.now(), text, role: "assistant" }),
  });
}

async function runWatcher(ref?: string) {
  if (!ref) {
    console.error('[watch] usage: justanotetaker-mcp watch "<board name or id>"');
    process.exit(1);
  }
  const board = await resolveBoard(ref);
  console.error(`[watch] listening on "${board.name}" (every ${POLL_MS}ms). New turns get a ${CLAUDE_BIN} reply. Ctrl+C to stop.`);
  let handledT = -1;
  for (;;) {
    try {
      const notes = await threadNotes(board.id);
      const last = notes[notes.length - 1];
      if (last && last.role !== "assistant" && last.t !== handledT) {
        handledT = last.t; // claim it up front so a slow reply doesn't double-fire
        const messages = notes.map((n) => ({ role: n.role === "assistant" ? "assistant" : "user", text: n.text }));
        console.error(`[watch] new turn — asking ${CLAUDE_BIN}…`);
        const reply = await runClaude(buildPrompt(board.name, messages));
        if (reply) {
          await postAssistantNote(board, reply);
          console.error(`[watch] replied (${reply.length} chars).`);
        } else {
          console.error("[watch] claude returned nothing; skipping this turn.");
        }
      }
    } catch (e) {
      console.error(`[watch] ${(e as Error).message}`);
    }
    await sleep(POLL_MS);
  }
}

if (process.argv[2] === "watch") {
  await runWatcher(process.argv[3] ?? process.env.JUSTNOTE_WATCH_BOARD);
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[justanotetaker-mcp] connected → ${API_URL}`);
}
