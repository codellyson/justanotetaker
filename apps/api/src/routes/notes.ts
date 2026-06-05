import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { createDb } from "../db/client";
import { notes } from "../db/schema";
import type { Env } from "../env";

const createSchema = z.object({
  id: z.string().optional(),
  x: z.number(),
  y: z.number(),
  t: z.number(),
  text: z.string().optional(),
});

const patchSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  t: z.number().optional(),
  text: z.string().optional(),
});

const listQuery = z.object({
  since: z.coerce.number().optional(),
  before: z.coerce.number().optional(),
});
const idParam = z.object({ id: z.string() });

const searchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

// Tokenize the user's input into FTS5 prefix-matched literals. Wrapping
// each token in double quotes neutralizes FTS5 operators (`*`, `OR`,
// `NEAR`, `:`) and the trailing `*` re-enables prefix match per token —
// so "rec" matches "recall", "recent", etc. Multiple tokens implicit-AND.
function toFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}

export const notesRoutes = new Hono<Env>()
  // List the caller's notes. ?since=<ms> returns only rows with updated_at > since
  // (including soft-deletes so clients can reconcile). Without ?since, soft-deleted
  // rows are filtered out — that's the initial-load path.
  .get("/", zValidator("query", listQuery), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const { since, before } = c.req.valid("query");

    const conds = [eq(notes.userId, userId)];
    if (since != null) {
      // Delta sync — include soft-deletes so clients can reconcile.
      conds.push(gt(notes.updatedAt, since));
    } else {
      conds.push(isNull(notes.deletedAt));
    }
    if (before != null) conds.push(lte(notes.t, before));

    const rows = await db.select().from(notes).where(and(...conds));
    return c.json({ notes: rows, serverTime: Date.now() });
  })
  // FTS5-backed text search. Filters to the caller's notes + non-deleted
  // at query time (the FTS index itself is ownership-agnostic). bm25
  // ranks results; snippet() returns a 20-token excerpt with <mark> tags
  // around the matched terms.
  .get("/search", zValidator("query", searchQuery), async (c) => {
    // Drizzle's query builder doesn't model FTS5 — fall through to D1's
    // raw prepared statement for the MATCH + JOIN + rank ORDER BY.
    const userId = c.get("userId");
    const { q, limit } = c.req.valid("query");
    const ftsQuery = toFtsQuery(q);
    if (!ftsQuery) return c.json({ matches: [], serverTime: Date.now() });

    type Row = {
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
      .all<Row>();

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
  .post("/", zValidator("json", createSchema), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const id = body.id ?? crypto.randomUUID();
    const now = Date.now();
    const row = {
      id,
      userId,
      x: body.x,
      y: body.y,
      t: body.t,
      text: body.text ?? "",
      updatedAt: now,
      deletedAt: null as number | null,
    };
    await db.insert(notes).values(row);
    return c.json({ note: row });
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", patchSchema), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const updates: Partial<{ x: number; y: number; t: number; text: string; updatedAt: number }> = {
      updatedAt: Date.now(),
    };
    if (typeof body.x === "number") updates.x = body.x;
    if (typeof body.y === "number") updates.y = body.y;
    if (typeof body.t === "number") updates.t = body.t;
    if (typeof body.text === "string") updates.text = body.text;

    const result = await db
      .update(notes)
      .set(updates)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .returning();
    if (result.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ note: result[0] });
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const now = Date.now();
    const result = await db
      .update(notes)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .returning({ id: notes.id });
    if (result.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, id, deletedAt: now });
  });
