# Agent rules

A pnpm workspace with four surfaces. Read this before touching code — your training data probably predates several of these choices.

## Stack contracts

- **TypeScript everywhere.** React 19 + Vite 6 on the frontend, Hono on Workers on the backend, Astro 5 for marketing, Tauri 2 + Rust for the desktop shell. Tailwind 4 (CSS-config via `@config` directive).
- **Auth is Better Auth.** Anonymous-first via the `anonymous()` plugin — every visitor gets a real user row before doing anything. The plugin's `onLinkAccount` callback transfers FK'd rows to the new user_id when an anon upgrades to email/password or OAuth. Don't hand-roll sessions, cookies, or user tables.
- **Design system is [`@codellyson/justui`](https://www.npmjs.com/package/@codellyson/justui).** Use the `Button` / `Field` / `Modal` / `ThemeToggle` primitives + token-based Tailwind utilities (`bg-bg`, `text-primary`, `bg-accent`, …). Don't introduce new hardcoded colors — they won't theme.
- **Tauri talks to the API over HTTPS** like the browser does. The webview uses Better Auth's `bearer()` plugin with the token persisted in OS keychain; the browser uses cookies. The transport switch lives in `apps/web/src/lib/auth-client.ts`, gated on `isTauri`.
- **OAuth in Tauri** uses the RFC 8252 localhost-listener pattern via `tauri-plugin-oauth`, not a custom URL scheme. The system browser bounces back to a localhost port the Rust side spun up, not `justnotetaking://`.

## Sharp edges

- **Hono trie router.** Registering a specific path under the same prefix as a wildcard breaks wildcard matching. The Better Auth wildcard at `/api/auth/**` is fragile; our `/api/desktop-callback` deliberately sits outside `/api/auth/` for this reason. Don't add `app.get("/api/auth/whatever", …)` — proxy through your own path instead.
- **Tailwind 4 preset wiring.** The justui preset is Tailwind 3-style JS config; we load it via `@config "./tailwind.config.cjs"` in `global.css`. Both `apps/web` and `apps/marketing` need that line — without it `bg-accent` etc. resolve to nothing.
- **`pnpm.overrides` is load-bearing.** `kysely` and `vite` are pinned via overrides because Better Auth's bundled D1 dialect builds against a specific kysely, and Vite resolves to one major across the workspace. Don't remove the pins without re-validating with `wrangler dev`.
- **No ORM — raw D1 SQL.** The API talks to D1 directly via `c.env.DB.prepare(…).bind(…)`. Domain queries live inline in `apps/api/src/routes/{notes,settings}.ts`; there's no schema/client module. Better Auth owns its own tables through its built-in Kysely-D1 dialect (`database: env.DB` in `auth.ts`) — it duck-types the binding, no adapter package. Migrations are hand-written `.sql` files in `apps/api/migrations/` (create scaffolds with `pnpm --filter @justnotetaking/api db:migrate:create`, apply with `db:migrate:local`/`:remote`). The FTS5 migration (`0002_notes_fts.sql`) and its triggers are the search index — keep `notes` column names stable so the triggers don't break.

## Workflow

- Per-app commands live under `pnpm --filter @justnotetaking/<app> <script>`. Root `pnpm dev` runs the web app only.
- After Cargo changes in `src-tauri`, `tauri:dev` needs a restart (Rust recompile).
- Wrangler hot-reloads code but **not** `wrangler.jsonc` `vars` — restart it when you edit env config.
- The OG image generator (`python3 brand/build.py`) uses Pillow + macOS's SFNS.ttf. Won't crash without Pillow but will skip the OG output.

## Related repos

- `../justui` — the `@codellyson/justui` design system (Astro + React adapters). When iterating on shared UI, link with `pnpm link` or bump the npm version.
- `../justdb` — sibling app (desktop Postgres explorer, same Tauri+Vite shape).

## When in doubt

`docs/migration.md` has the phase-by-phase rationale for why the stack looks like this. `docs/deploy.md` (Cloudflare) and `docs/deploy-vps.md` (self-hosted) cover shipping.
