import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "d1-http",
  // The d1-http driver is only used for `drizzle-kit push` / `drizzle-kit studio`,
  // both of which need real Cloudflare credentials (account_id, database_id, token).
  // For local migrations we don't push directly — we generate SQL files with
  // `drizzle-kit generate` and apply via `wrangler d1 migrations apply --local`.
} satisfies Config;
