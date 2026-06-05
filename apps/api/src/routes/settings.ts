import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { settings } from "../db/schema";
import type { Env } from "../env";

const putSchema = z.object({
  tweaks: z.string().nullable().optional(),
  seeded: z.boolean().optional(),
});

export const settingsRoutes = new Hono<Env>()
  // Read the caller's settings row. Returns nulls + seeded:false if none yet —
  // the client treats that as the first-visit signal.
  .get("/", async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const rows = await db.select().from(settings).where(eq(settings.userId, userId));
    const row = rows[0];
    return c.json({
      tweaks: row?.tweaks ?? null,
      seeded: row?.seeded ?? false,
      updatedAt: row?.updatedAt ?? null,
    });
  })
  // Upsert. Either field may be set independently — omit a field to leave it
  // unchanged. `tweaks` is stored as TEXT JSON; client serializes.
  .put("/", zValidator("json", putSchema), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const now = Date.now();

    const existing = await db.select().from(settings).where(eq(settings.userId, userId));
    if (existing.length === 0) {
      await db.insert(settings).values({
        userId,
        tweaks: body.tweaks ?? null,
        seeded: body.seeded ?? false,
        updatedAt: now,
      });
    } else {
      const updates: Partial<{ tweaks: string | null; seeded: boolean; updatedAt: number }> = {
        updatedAt: now,
      };
      if (body.tweaks !== undefined) updates.tweaks = body.tweaks;
      if (body.seeded !== undefined) updates.seeded = body.seeded;
      await db.update(settings).set(updates).where(eq(settings.userId, userId));
    }

    const rows = await db.select().from(settings).where(eq(settings.userId, userId));
    const row = rows[0]!;
    return c.json({ tweaks: row.tweaks, seeded: row.seeded, updatedAt: row.updatedAt });
  });
