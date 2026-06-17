# Deploy runbook

Phase 4 lands the code/config so a deploy is mostly a matter of running the right `wrangler` commands against your own Cloudflare account. This file is the sequence — top to bottom on a fresh account, idempotent on subsequent runs.

Tauri release (code-signing, notarization, auto-update feed) is a separate sub-phase — covered at the bottom under "Desktop release."

---

## Prerequisites

- Cloudflare account with Workers + D1 + Pages enabled
- `wrangler` available (already in `apps/api/devDependencies`; use `pnpm --filter @justnotes/api exec wrangler ...` from the repo root)
- A custom domain on Cloudflare DNS (the runbook assumes `justnotes.kreativekorna.com` for marketing/web and `api.justnotes.kreativekorna.com` for the Worker — search/replace if yours differs)
- Optional: Google Cloud Console OAuth client (only needed if you want the Google sign-in button)

```sh
cd /path/to/justnotes
pnpm install   # if you haven't already
pnpm --filter @justnotes/api exec wrangler login
```

---

## 1 · Provision D1

Each env (dev/prod) gets its own D1 instance.

```sh
# One-time per env. Copy the database_id from the output into wrangler.jsonc.
pnpm --filter @justnotes/api exec wrangler d1 create justnotes-dev
pnpm --filter @justnotes/api exec wrangler d1 create justnotes-prod
```

Open `apps/api/wrangler.jsonc` and replace both `REPLACE_ME_RUN_wrangler_d1_create` placeholders with the real IDs:
- Top-level `d1_databases[0].database_id` → the dev ID
- `env.production.d1_databases[0].database_id` → the prod ID

Apply migrations to both:

```sh
# Dev (uses miniflare in-memory by default; --remote hits the real D1)
pnpm --filter @justnotes/api db:migrate:local       # local SQLite
pnpm --filter @justnotes/api exec wrangler d1 migrations apply justnotes-dev --remote

# Prod
pnpm --filter @justnotes/api db:migrate:remote
```

---

## 2 · Secrets

Required for any env that actually serves traffic:

```sh
# BETTER_AUTH_SECRET — random 32-byte hex. Different per env.
openssl rand -hex 32 | pnpm --filter @justnotes/api exec wrangler secret put BETTER_AUTH_SECRET --env production
```

Optional — Google OAuth. Skip if you only want email/password sign-in.

```sh
# From Google Cloud Console → APIs & Services → Credentials → OAuth client ID
pnpm --filter @justnotes/api exec wrangler secret put GOOGLE_CLIENT_ID --env production
pnpm --filter @justnotes/api exec wrangler secret put GOOGLE_CLIENT_SECRET --env production
```

The Google OAuth callback URL to register in the Cloud Console is:
`https://api.justnotes.kreativekorna.com/api/auth/callback/google`

---

## 3 · Deploy the Worker

```sh
pnpm --filter @justnotes/api exec wrangler deploy --env production
```

The first deploy will print the `*.workers.dev` URL the Worker is now reachable at. You can hit it directly to smoke-test before attaching the custom domain.

### Custom domain

Either:
- Leave `routes` in `wrangler.jsonc#env.production` and rerun `wrangler deploy --env production` (wrangler attaches the route on your behalf), **or**
- Skip the `routes` block and attach via the Cloudflare dashboard → Workers → your worker → Triggers → Add Custom Domain.

DNS: a proxied CNAME for `api.justnotes.kreativekorna.com` to the workers.dev hostname. (The dashboard's "Add Custom Domain" creates this automatically.)

### Smoke test

```sh
# Health
curl https://api.justnotes.kreativekorna.com/api/health
# → {"ok":true,"time":...}

# Anonymous sign-in (cookie ends up in the jar)
JAR=/tmp/jn.cookies && rm -f "$JAR"
curl -s -c "$JAR" -X POST \
  https://api.justnotes.kreativekorna.com/api/auth/sign-in/anonymous \
  -H "Content-Type: application/json" \
  -H "Origin: https://justnotes.kreativekorna.com" \
  -d '{}' | jq .user.id

# Whoami
curl -s -b "$JAR" \
  -H "Origin: https://justnotes.kreativekorna.com" \
  https://api.justnotes.kreativekorna.com/api/me | jq .
```

If `INVALID_ORIGIN` comes back, double-check `TRUSTED_ORIGINS` in `wrangler.jsonc#env.production.vars` includes the exact origin you're sending from.

---

## 4 · Deploy the marketing site (Astro on Pages)

Static build, no SSR — Pages serves the `dist/` directly.

```sh
# Build with the prod URLs baked into the CTAs
PUBLIC_WEB_URL=https://justnotes.kreativekorna.com \
PUBLIC_DESKTOP_URL=https://github.com/your-org/justnotes/releases/latest \
pnpm --filter @justnotes/marketing build

# Deploy (first run prompts for project name + branch settings)
pnpm --filter @justnotes/marketing exec wrangler pages deploy dist --project-name justnotes-marketing
```

For continuous deploys, hook Pages up to the GitHub repo in the dashboard with this build command:
- Build command: `pnpm install --frozen-lockfile && pnpm --filter @justnotes/marketing build`
- Build output dir: `apps/marketing/dist`
- Root dir: leave blank (Pages will run at repo root)
- Env vars: `PUBLIC_WEB_URL`, `PUBLIC_DESKTOP_URL`

DNS: a proxied CNAME for `justnotes.kreativekorna.com` to the pages.dev hostname.

---

## 5 · Deploy the web app (Vite SPA on Pages)

The web app is a static Vite bundle. Same Pages flow as marketing, different project.

```sh
# Build with the prod API URL
VITE_API_BASE_URL=https://api.justnotes.kreativekorna.com \
pnpm --filter @justnotes/web build

pnpm --filter @justnotes/web exec wrangler pages deploy dist --project-name justnotes-web
```

`VITE_API_BASE_URL` is honored by `apps/web/src/lib/runtime.ts` — set it to override the prod default for staging/preview builds.

Web app domain: `app.justnotes.kreativekorna.com` (or the bare apex — your call). Update `TRUSTED_ORIGINS` in the Worker's prod env to match before deploying the Worker, or sign-in will 403.

---

## 6 · Desktop release (Tauri)

Deferred. The shell compiles and `tauri:dev` opens a window today, but production binaries require:

- macOS: Apple Developer ID certificate + notarization (paid Apple account)
- Windows: code-signing certificate (paid CA)
- Linux: optional AppImage signing
- Auto-update: a signed `latest.json` feed (commonly on GitHub Releases) + `tauri-plugin-updater` wiring

When ready:
1. Enable `bundle.active: true` in `src-tauri/tauri.conf.json` and supply real icons (use `pnpm tauri icon path/to/source-1024.png` to generate the set)
2. Add the updater plugin + endpoint to `tauri.conf.json#plugins.updater`
3. Configure signing identities in env (Tauri's docs cover `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, etc.)
4. `pnpm tauri:build` per platform; ship the artifacts to GitHub Releases

OAuth-in-Tauri is its own sub-phase (system-browser handoff + deep link). See `docs/migration.md#phase-3` for the design; not implemented yet.

---

## Rollback

D1 has no built-in rollback, so keep migrations forward-only and additive when possible. For Workers code:

```sh
pnpm --filter @justnotes/api exec wrangler rollback --env production
```

That reverts to the previous deployment; combine with a follow-up migration if the rollback puts code and schema out of sync.

---

## Local-only — `.dev.vars`

For local development, secrets live in `apps/api/.dev.vars` (gitignored). Generate:

```sh
cat > apps/api/.dev.vars <<EOF
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# Optional, for testing Google sign-in locally:
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
EOF
```

The Google OAuth callback for local: `http://localhost:8787/api/auth/callback/google` (register as an extra redirect URI in the Cloud Console).
