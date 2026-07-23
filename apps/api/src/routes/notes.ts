import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";

const kindSchema = z.enum(["card", "page", "frame", "image", "task"]);

// Kind-specific payloads carried in the `meta` JSON column. The shapes are
// disjoint (key vs status), so a plain union stays unambiguous even on
// kind-less PATCHes.
const imageMetaSchema = z.object({
  key: z.string().max(200),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  alt: z.string().max(500).optional(),
});
const taskMetaSchema = z.object({
  status: z.enum(["queued", "running", "done", "error"]),
  prompt: z.string().max(20000),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  error: z.string().max(4000).optional(),
});
const metaSchema = z.union([imageMetaSchema, taskMetaSchema]).nullable().optional();

const createSchema = z.object({
  id: z.string().optional(),
  boardId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().nullable().optional(),
  h: z.number().nullable().optional(),
  t: z.number(),
  text: z.string().optional(),
  kind: kindSchema.optional(),
  color: z.string().max(32).nullable().optional(),
  role: z.string().max(16).nullable().optional(),
  parentId: z.string().max(64).nullable().optional(),
  meta: metaSchema,
});

const patchSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().nullable().optional(),
  h: z.number().nullable().optional(),
  t: z.number().optional(),
  text: z.string().optional(),
  kind: kindSchema.optional(),
  color: z.string().max(32).nullable().optional(),
  role: z.string().max(16).nullable().optional(),
  parentId: z.string().max(64).nullable().optional(),
  meta: metaSchema,
});

const listQuery = z.object({
  since: z.coerce.number().optional(),
  before: z.coerce.number().optional(),
  board: z.string().optional(),
});
const idParam = z.object({ id: z.string() });

const searchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const GRAVEYARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const NOTE_COLS = "id, user_id, x, y, w, h, t, text, updated_at, deleted_at, board_id, kind, color, role, parent_id, meta";

type NoteRow = {
  id: string;
  user_id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  t: number;
  text: string;
  updated_at: number;
  deleted_at: number | null;
  board_id: string | null;
  kind: string;
  color: string | null;
  role: string | null;
  parent_id: string | null;
  meta: string | null;
};

function parseMeta(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toNote(r: NoteRow) {
  return {
    id: r.id,
    userId: r.user_id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    t: r.t,
    text: r.text,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    boardId: r.board_id,
    kind: r.kind,
    color: r.color,
    role: r.role,
    parentId: r.parent_id,
    meta: parseMeta(r.meta),
  };
}

// Wrap each whitespace-delimited token in double quotes (neutralizes FTS5
// operators *, OR, NEAR, :), then append * for prefix match per token.
function toFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}

export const notesRoutes = new Hono<Env>()
  .get("/", zValidator("query", listQuery), async (c) => {
    const userId = c.get("userId");
    const { since, before, board } = c.req.valid("query");

    const conds = ["user_id = ?"];
    const binds: (string | number)[] = [userId];
    if (since != null) {
      conds.push("updated_at > ?");
      binds.push(since);
    } else {
      conds.push("deleted_at IS NULL");
    }
    if (before != null) {
      conds.push("t <= ?");
      binds.push(before);
    }
    if (board != null) {
      conds.push("board_id = ?");
      binds.push(board);
    }

    const { results } = await c.env.DB.prepare(
      `SELECT ${NOTE_COLS} FROM notes WHERE ${conds.join(" AND ")}`,
    )
      .bind(...binds)
      .all<NoteRow>();
    return c.json({ notes: (results ?? []).map(toNote), serverTime: Date.now() });
  })
  .get("/deleted", async (c) => {
    const userId = c.get("userId");
    const cutoff = Date.now() - GRAVEYARD_WINDOW_MS;
    const { results } = await c.env.DB.prepare(
      `SELECT ${NOTE_COLS} FROM notes
       WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ?
       ORDER BY deleted_at DESC`,
    )
      .bind(userId, cutoff)
      .all<NoteRow>();
    return c.json({ notes: (results ?? []).map(toNote), serverTime: Date.now() });
  })
  .get("/search", zValidator("query", searchQuery), async (c) => {
    const userId = c.get("userId");
    const { q, limit } = c.req.valid("query");
    const ftsQuery = toFtsQuery(q);
    if (!ftsQuery) return c.json({ matches: [], serverTime: Date.now() });

    type SearchRow = {
      id: string;
      x: number;
      y: number;
      t: number;
      text: string;
      updated_at: number;
      snippet: string;
    };

    const { results } = await c.env.DB.prepare(
      `SELECT notes.id, notes.x, notes.y, notes.t, notes.text, notes.updated_at,
              snippet(notes_fts, 0, '<mark>', '</mark>', '…', 20) AS snippet
       FROM notes_fts
       JOIN notes ON notes.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ?
         AND notes.user_id = ?
         AND notes.deleted_at IS NULL
       ORDER BY rank
       LIMIT ?`,
    )
      .bind(ftsQuery, userId, limit ?? 50)
      .all<SearchRow>();

    return c.json({
      matches: (results ?? []).map((r) => ({
        id: r.id,
        x: r.x,
        y: r.y,
        t: r.t,
        text: r.text,
        updatedAt: r.updated_at,
        snippet: r.snippet,
      })),
      serverTime: Date.now(),
    });
  })
  // Deliberately /by-id/:id, not /:id — a param GET beside the static GETs
  // (/deleted, /search) trips RegExpRouter into the TrieRouter fallback,
  // which breaks the Better Auth /api/auth/** wildcard (see AGENTS.md).
  .get("/by-id/:id", zValidator("param", idParam), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const { results } = await c.env.DB.prepare(
      `SELECT ${NOTE_COLS} FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
      .bind(id, userId)
      .all<NoteRow>();
    if (!results || results.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ note: toNote(results[0]) });
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const id = body.id ?? crypto.randomUUID();
    const now = Date.now();
    const note = {
      id,
      userId,
      x: body.x,
      y: body.y,
      w: body.w ?? null,
      h: body.h ?? null,
      t: body.t,
      text: body.text ?? "",
      updatedAt: now,
      deletedAt: null as number | null,
      boardId: body.boardId,
      kind: body.kind ?? "card",
      color: body.color ?? null,
      role: body.role ?? null,
      parentId: body.parentId ?? null,
      meta: body.meta ?? null,
    };
    await c.env.DB.prepare(
      `INSERT INTO notes (${NOTE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(note.id, note.userId, note.x, note.y, note.w, note.h, note.t, note.text, note.updatedAt, note.deletedAt, note.boardId, note.kind, note.color, note.role, note.parentId, note.meta == null ? null : JSON.stringify(note.meta))
      .run();
    return c.json({ note });
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", patchSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const sets = ["updated_at = ?"];
    const binds: (string | number | null)[] = [Date.now()];
    if (typeof body.x === "number") { sets.push("x = ?"); binds.push(body.x); }
    if (typeof body.y === "number") { sets.push("y = ?"); binds.push(body.y); }
    if (body.w !== undefined) { sets.push("w = ?"); binds.push(body.w); }
    if (body.h !== undefined) { sets.push("h = ?"); binds.push(body.h); }
    if (typeof body.t === "number") { sets.push("t = ?"); binds.push(body.t); }
    if (typeof body.text === "string") { sets.push("text = ?"); binds.push(body.text); }
    if (body.kind !== undefined) { sets.push("kind = ?"); binds.push(body.kind); }
    if (body.color !== undefined) { sets.push("color = ?"); binds.push(body.color); }
    if (body.role !== undefined) { sets.push("role = ?"); binds.push(body.role); }
    if (body.parentId !== undefined) { sets.push("parent_id = ?"); binds.push(body.parentId); }
    if (body.meta !== undefined) { sets.push("meta = ?"); binds.push(body.meta == null ? null : JSON.stringify(body.meta)); }

    const { results } = await c.env.DB.prepare(
      `UPDATE notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ? RETURNING ${NOTE_COLS}`,
    )
      .bind(...binds, id, userId)
      .all<NoteRow>();
    if (!results || results.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ note: toNote(results[0]) });
  })
  .post("/:id/restore", zValidator("param", idParam), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const now = Date.now();
    const { results } = await c.env.DB.prepare(
      `UPDATE notes SET deleted_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? RETURNING ${NOTE_COLS}`,
    )
      .bind(now, id, userId)
      .all<NoteRow>();
    if (!results || results.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ note: toNote(results[0]) });
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const now = Date.now();
    const { results } = await c.env.DB.prepare(
      `UPDATE notes SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? RETURNING id`,
    )
      .bind(now, now, id, userId)
      .all<{ id: string }>();
    if (!results || results.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, id, deletedAt: now });
  });
