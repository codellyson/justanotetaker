import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
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

const listQuery = z.object({ since: z.coerce.number().optional() });
const idParam = z.object({ id: z.string() });

export const notesRoutes = new Hono<Env>()
  // List the caller's notes. ?since=<ms> returns only rows with updated_at > since
  // (including soft-deletes so clients can reconcile). Without ?since, soft-deleted
  // rows are filtered out — that's the initial-load path.
  .get("/", zValidator("query", listQuery), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const { since } = c.req.valid("query");

    const rows = since != null
      ? await db
          .select()
          .from(notes)
          .where(and(eq(notes.userId, userId), gt(notes.updatedAt, since)))
      : await db
          .select()
          .from(notes)
          .where(and(eq(notes.userId, userId), isNull(notes.deletedAt)));

    return c.json({ notes: rows, serverTime: Date.now() });
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
