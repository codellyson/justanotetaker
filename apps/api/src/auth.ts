import { betterAuth } from "better-auth";
import { anonymous, bearer } from "better-auth/plugins";
import type { D1Database } from "@cloudflare/workers-types";

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  // Comma-separated list of origins Better Auth (and the CORS layer)
  // will trust. Required — Better Auth rejects every cross-origin POST
  // from an unknown origin with INVALID_ORIGIN. Configured per-env in
  // wrangler.jsonc; the dev default covers the localhost ports.
  TRUSTED_ORIGINS: string;
  // Optional — Google sign-in is gated on both being set. Worker boots
  // without them; the auth client just won't surface the Google button.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

function parseTrustedOrigins(env: AuthEnv): string[] {
  return (env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hasGoogleProvider(env: AuthEnv): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// Auth instance is created per-request because Workers env (D1 binding,
// secrets) is per-request, not module-level. Init cost is negligible.
export function createAuth(env: AuthEnv) {
  return betterAuth({
    // Better Auth duck-types the D1 binding (batch/exec/prepare) and uses
    // its internal Kysely D1 dialect — no separate adapter package needed.
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Browsers send Origin on cross-origin POSTs; Better Auth blocks any
    // origin not in this list. baseURL is implicitly trusted; everything
    // else (vite dev, astro dev, tauri webview, prod marketing) must be
    // listed. Source is the TRUSTED_ORIGINS env (comma-separated) so
    // dev/prod allowlists live next to the rest of the wrangler config.
    trustedOrigins: parseTrustedOrigins(env),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: hasGoogleProvider(env)
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
          },
        }
      : undefined,
    plugins: [
      anonymous({
        // Fires when an anonymous user upgrades to a real account. Move every
        // row the anon owns to the new user_id BEFORE Better Auth deletes the
        // anon user row — otherwise the FK `ON DELETE CASCADE` on these tables
        // hard-deletes them. boards especially: miss it and the upgrade wipes
        // the user's canvases, stranding their (transferred) notes on board
        // ids that no longer exist, and they land on a fresh empty board.
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          const from = anonymousUser.user.id;
          const to = newUser.user.id;
          await env.DB.batch([
            env.DB.prepare("UPDATE notes SET user_id = ? WHERE user_id = ?").bind(to, from),
            env.DB.prepare("UPDATE boards SET user_id = ? WHERE user_id = ?").bind(to, from),
            // settings.user_id is the PRIMARY KEY. Signing IN to an existing
            // account (not just signing up) also links, and that account may
            // already have a settings row — a plain UPDATE would collide on
            // the PK and, because batch() is one transaction, roll back the
            // notes/boards transfer too. OR IGNORE keeps the existing account's
            // settings and drops the anon row (cascade-removed with the user).
            env.DB.prepare("UPDATE OR IGNORE settings SET user_id = ? WHERE user_id = ?").bind(to, from),
          ]);
        },
      }),
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
