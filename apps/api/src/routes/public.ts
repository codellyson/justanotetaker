import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";

// Read-only view of a public board; the unguessable board id is the
// capability. ONE param route only — a static GET sibling would trip the
// router hazard (see the /by-id note in notes.ts).

const idParam = z.object({ id: z.string() });

type PublicNoteRow = {
  id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  t: number;
  text: string;
  updated_at: number;
  board_id: string | null;
  kind: string;
  color: string | null;
  role: string | null;
  parent_id: string | null;
  meta: string | null;
};

// Not notes.ts's toNote — that one includes userId.
function toPublicNote(r: PublicNoteRow) {
  let meta: unknown = null;
  if (r.meta) {
    try {
      meta = JSON.parse(r.meta);
    } catch {
      meta = null;
    }
  }
  return {
    id: r.id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    t: r.t,
    text: r.text,
    updatedAt: r.updated_at,
    boardId: r.board_id,
    kind: r.kind,
    color: r.color,
    role: r.role,
    parentId: r.parent_id,
    meta,
  };
}

export const publicRoutes = new Hono<Env>().get(
  "/boards/:id",
  zValidator("param", idParam),
  async (c) => {
    const { id } = c.req.valid("param");
    const board = await c.env.DB.prepare(
      `SELECT id, user_id, name FROM boards
       WHERE id = ? AND visibility = 'public' AND deleted_at IS NULL`,
    )
      .bind(id)
      .first<{ id: string; user_id: string; name: string }>();
    if (!board) return c.json({ error: "not found" }, 404);

    const [noteRes, linkRes] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, x, y, w, h, t, text, updated_at, board_id, kind, color, role, parent_id, meta
         FROM notes WHERE board_id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
        .bind(board.id, board.user_id)
        .all<PublicNoteRow>(),
      c.env.DB.prepare(
        `SELECT id, a_id, b_id FROM note_links WHERE board_id = ? AND user_id = ?`,
      )
        .bind(board.id, board.user_id)
        .all<{ id: string; a_id: string; b_id: string }>(),
    ]);

    return c.json({
      board: { id: board.id, name: board.name },
      notes: (noteRes.results ?? []).map(toPublicNote),
      links: (linkRes.results ?? []).map((l) => ({ id: l.id, aId: l.a_id, bId: l.b_id })),
      serverTime: Date.now(),
    });
  },
);
