import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";
import type { D1Database } from "@cloudflare/workers-types";

// Personal API tokens. The raw token (`jnt_` + 40 hex chars) is shown once at
// creation; only its SHA-256 hash is stored, so a DB leak can't be replayed.
const TOKEN_PREFIX = "jnt_";

function genToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return TOKEN_PREFIX + hex;
}

async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Pull a `jnt_` token from Authorization: Bearer … or the x-api-key header.
// Session (Better Auth) bearer tokens don't carry this prefix, so the two
// schemes never collide.
function extractToken(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].startsWith(TOKEN_PREFIX)) return m[1].trim();
  }
  const key = headers.get("x-api-key");
  if (key && key.startsWith(TOKEN_PREFIX)) return key.trim();
  return null;
}

// Resolve a request's API token to a user id, or null. Called from the session
// middleware as a fallback when there's no Better Auth session. Best-effort
// bumps last_used_at (fire-and-forget) so stale keys are visible in the UI.
export async function resolveApiToken(db: D1Database, headers: Headers): Promise<{ id: string } | null> {
  const raw = extractToken(headers);
  if (!raw) return null;
  const hash = await hashToken(raw);
  const row = await db
    .prepare("SELECT user_id FROM api_tokens WHERE token_hash = ? AND deleted_at IS NULL")
    .bind(hash)
    .first<{ user_id: string }>();
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(Date.now(), hash)
    .run()
    .catch(() => {});
  return { id: row.user_id };
}

const createSchema = z.object({ name: z.string().min(1).max(80) });
const idParam = z.object({ id: z.string() });

const TOKEN_COLS = "id, name, prefix, created_at, last_used_at";

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
};

const toToken = (r: TokenRow) => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export const tokensRoutes = new Hono<Env>()
  .get("/", async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      `SELECT ${TOKEN_COLS} FROM api_tokens WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all<TokenRow>();
    return c.json({ tokens: (results ?? []).map(toToken) });
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const userId = c.get("userId");
    const { name } = c.req.valid("json");
    const raw = genToken();
    const hash = await hashToken(raw);
    const id = crypto.randomUUID();
    const prefix = raw.slice(0, TOKEN_PREFIX.length + 6);
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, userId, name, hash, prefix, now)
      .run();
    // `token` is returned exactly once — it's never retrievable again.
    return c.json({ token: { id, name, prefix, createdAt: now, lastUsedAt: null }, secret: raw }, 201);
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    await c.env.DB.prepare("UPDATE api_tokens SET deleted_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), id, userId)
      .run();
    return c.body(null, 204);
  });
