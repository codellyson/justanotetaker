import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";

const createSchema = z.object({
  id: z.string().optional(),
  boardId: z.string(),
  aId: z.string(),
  bId: z.string(),
});

const listQuery = z.object({ board: z.string().optional() });
const idParam = z.object({ id: z.string() });

type LinkRow = {
  id: string;
  board_id: string | null;
  a_id: string;
  b_id: string;
  created_at: number;
};

function toLink(r: LinkRow) {
  return { id: r.id, boardId: r.board_id, aId: r.a_id, bId: r.b_id, createdAt: r.created_at };
}

export const linksRoutes = new Hono<Env>()
  .get("/", zValidator("query", listQuery), async (c) => {
    const userId = c.get("userId");
    const { board } = c.req.valid("query");
    const conds = ["user_id = ?"];
    const binds: string[] = [userId];
    if (board != null) {
      conds.push("board_id = ?");
      binds.push(board);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT id, board_id, a_id, b_id, created_at FROM note_links WHERE ${conds.join(" AND ")}`,
    )
      .bind(...binds)
      .all<LinkRow>();
    return c.json({ links: (results ?? []).map(toLink), serverTime: Date.now() });
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");
    if (body.aId === body.bId) return c.json({ error: "self link" }, 400);
    // Undirected: store the pair sorted so the unique index dedupes both ways.
    const [aId, bId] = body.aId < body.bId ? [body.aId, body.bId] : [body.bId, body.aId];
    const id = body.id ?? crypto.randomUUID();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO note_links (id, user_id, board_id, a_id, b_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, a_id, b_id) DO NOTHING`,
    )
      .bind(id, userId, body.boardId, aId, bId, now)
      .run();
    // Return the canonical row — on a duplicate that's the pre-existing link.
    const { results } = await c.env.DB.prepare(
      `SELECT id, board_id, a_id, b_id, created_at FROM note_links
       WHERE user_id = ? AND a_id = ? AND b_id = ?`,
    )
      .bind(userId, aId, bId)
      .all<LinkRow>();
    return c.json({ link: toLink(results![0]) });
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    await c.env.DB.prepare(`DELETE FROM note_links WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .run();
    return c.json({ ok: true, id });
  });
