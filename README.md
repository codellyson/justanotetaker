# justnotes

Spatial notes on a dark canvas — click anywhere to write, drag to place, type to recall. Notes age visually (fresh → ancient) and sync across devices.

## Stack

- **apps/web** — Vite 6 + React 19 + Tailwind 4 + [@codellyson/justui](https://www.npmjs.com/package/@codellyson/justui) design system
- **apps/api** — Hono on Cloudflare Workers + Drizzle ORM + Better Auth (anonymous + email/password + Google OAuth) + D1 with FTS5 for ambient search
- **apps/marketing** — Astro 5 (static, deployed to Pages)
- **packages/api-client** — shared Hono RPC client (end-to-end types)
- **src-tauri** — Tauri 2 desktop shell (same Vite frontend, bearer-token sessions in OS keychain, localhost-listener OAuth)

Monorepo managed by pnpm workspaces.

## Run locally

You need two (or three) terminals.

```sh
# Terminal 1 — API (Worker + local D1)
pnpm --filter @justnotes/api dev          # → :8787

# Terminal 2 — Web app
pnpm --filter @justnotes/web dev          # → :5173
# or marketing:
pnpm --filter @justnotes/marketing dev    # → :4321

# Terminal 3 (optional) — desktop shell
pnpm tauri:dev                            # spawns vite as a subprocess
```

First time only — apply local D1 migrations:

```sh
pnpm --filter @justnotes/api db:migrate:local
```

You'll also need `apps/api/.dev.vars`:

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# Optional — light up the Google sign-in button:
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
```

## Brand assets

Canonical sources live in `brand/`. Regenerate raster derivatives (Tauri icons, favicons, OG image, marketing hero):

```sh
python3 brand/build.py
```

Details: [`brand/README.md`](brand/README.md).

## Deploying

The Cloudflare-side runbook is in [`docs/deploy.md`](docs/deploy.md). A self-hosted (VPS) variant lives in [`docs/deploy-vps.md`](docs/deploy-vps.md) for when you'd rather run the Hono server on your own infrastructure.

## Migration history

`docs/migration.md` captures the phase-by-phase rewrite from the original Next.js scaffold to the current stack. Mostly historical at this point — interesting if you're following why the architecture looks the way it does.
