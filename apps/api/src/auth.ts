import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, bearer } from "better-auth/plugins";
import { createDb } from "./db/client";
import { schema } from "./db/schema";

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
};

// Auth instance is created per-request because Workers env (D1 binding,
// secrets) is per-request, not module-level. Init cost is negligible.
export function createAuth(env: AuthEnv) {
  const db = createDb(env.DB);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      anonymous(),
      bearer(),
      // OAuth providers (Google, etc.) are added in Phase 3 — see docs/migration.md
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
