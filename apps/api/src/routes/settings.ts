import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";

const putSchema = z.object({
  tweaks: z.string().nullable().optional(),
  seeded: z.boolean().optional(),
});

type SettingsRow = {
  user_id: string;
  tweaks: string | null;
  seeded: number;
  updated_at: number;
};

async function readSettings(db: Env["Bindings"]["DB"], userId: string) {
  const { results } = await db
    .prepare("SELECT user_id, tweaks, seeded, updated_at FROM settings WHERE user_id = ?")
    .bind(userId)
    .all<SettingsRow>();
  return results?.[0];
}

export const settingsRoutes = new Hono<Env>()
  // Read the caller's settings row. Returns nulls + seeded:false if none yet —
  // the client treats that as the first-visit signal.
  .get("/", async (c) => {
    const row = await readSettings(c.env.DB, c.get("userId"));
    return c.json({
      tweaks: row?.tweaks ?? null,
      seeded: row ? row.seeded === 1 : false,
      updatedAt: row?.updated_at ?? null,
    });
  })
  // Upsert. Either field may be set independently — omit a field to leave it
  // unchanged. `tweaks` is stored as TEXT JSON; client serializes.
  .put("/", zValidator("json", putSchema), async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const now = Date.now();

    const existing = await readSettings(c.env.DB, userId);
    if (!existing) {
      await c.env.DB.prepare(
        "INSERT INTO settings (user_id, tweaks, seeded, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind(userId, body.tweaks ?? null, body.seeded ? 1 : 0, now)
        .run();
    } else {
      const sets = ["updated_at = ?"];
      const binds: (string | number | null)[] = [now];
      if (body.tweaks !== undefined) { sets.push("tweaks = ?"); binds.push(body.tweaks); }
      if (body.seeded !== undefined) { sets.push("seeded = ?"); binds.push(body.seeded ? 1 : 0); }
      await c.env.DB.prepare(`UPDATE settings SET ${sets.join(", ")} WHERE user_id = ?`)
        .bind(...binds, userId)
        .run();
    }

    const row = (await readSettings(c.env.DB, userId))!;
    return c.json({ tweaks: row.tweaks, seeded: row.seeded === 1, updatedAt: row.updated_at });
  });
