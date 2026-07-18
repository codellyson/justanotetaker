import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";

const createSchema = z.object({
  name: z.string().min(1),
  sort: z.number().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  sort: z.number().optional(),
});

const idParam = z.object({ id: z.string() });

const BOARD_COLS = "id, user_id, name, sort, created_at, updated_at, deleted_at";

type BoardRow = {
  id: string;
  user_id: string;
  name: string;
  sort: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

function toBoard(r: BoardRow) {
  return { id: r.id, name: r.name, sort: r.sort };
}

// Create the account's first canvas. Called when the board list is empty so
// every client (browser, desktop, or a token-only agent) always has a board
// to write to. A concurrent first request could in theory create two; that's
// benign (the user can delete one) and far cheaper than locking.
async function ensureFirstBoard(db: D1Database, userId: string) {
  const board = {
    id: crypto.randomUUID(),
    name: "Canvas",
    sort: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db
    .prepare(`INSERT INTO boards (${BOARD_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(board.id, userId, board.name, board.sort, board.createdAt, board.updatedAt, null)
    .run();
  return { id: board.id, name: board.name, sort: board.sort };
}

export const boardsRoutes = new Hono<Env>()
  .get("/", async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      `SELECT ${BOARD_COLS} FROM boards WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort, created_at`,
    )
      .bind(userId)
      .all<BoardRow>();
    // Every account owns at least one canvas. This invariant used to be the
    // web client's job (useBoards bootstrapped on an empty list), which left
    // token-only clients — an agent hitting the API before the human ever
    // opened the app — with nowhere to create a note. Own it server-side so
    // the guarantee holds for any client.
    if (!results || results.length === 0) {
      const board = await ensureFirstBoard(c.env.DB, userId);
      return c.json({ boards: [board] });
    }
    return c.json({ boards: results.map(toBoard) });
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const id = crypto.randomUUID();
    const now = Date.now();

    let sort = body.sort;
    if (sort == null) {
      const row = await c.env.DB.prepare(
        `SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM boards WHERE user_id = ? AND deleted_at IS NULL`,
      )
        .bind(userId)
        .first<{ n: number }>();
      sort = row?.n ?? 0;
    }

    const board = {
      id,
      userId,
      name: body.name,
      sort,
      createdAt: now,
      updatedAt: now,
      deletedAt: null as number | null,
    };
    await c.env.DB.prepare(
      `INSERT INTO boards (${BOARD_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(board.id, board.userId, board.name, board.sort, board.createdAt, board.updatedAt, board.deletedAt)
      .run();
    return c.json({ board: { id: board.id, name: board.name, sort: board.sort } });
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", patchSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const sets = ["updated_at = ?"];
    const binds: (string | number | null)[] = [Date.now()];
    if (typeof body.name === "string") { sets.push("name = ?"); binds.push(body.name); }
    if (typeof body.sort === "number") { sets.push("sort = ?"); binds.push(body.sort); }

    const { results } = await c.env.DB.prepare(
      `UPDATE boards SET ${sets.join(", ")} WHERE id = ? AND user_id = ? RETURNING ${BOARD_COLS}`,
    )
      .bind(...binds, id, userId)
      .all<BoardRow>();
    if (!results || results.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ board: toBoard(results[0]) });
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE boards SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).bind(now, now, id, userId),
      c.env.DB.prepare(
        `UPDATE notes SET deleted_at = ?, updated_at = ? WHERE board_id = ? AND user_id = ? AND deleted_at IS NULL`,
      ).bind(now, now, id, userId),
    ]);
    return c.json({ ok: true });
  });
