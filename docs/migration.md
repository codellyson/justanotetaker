# justnotetaking migration plan

Move justnotetaking off Next.js 16 and onto the stack we want to live with: **Vite 6 + React 19 + Tailwind 4** on the frontend, **Hono on Cloudflare Workers + D1** for the API, **Better Auth** for identity (anonymous from day one, OAuth later), **Astro** for the marketing site, and **Tauri 2** as a first-class desktop shell.

The repo shape mirrors `../justdb`'s pnpm-workspace monorepo, but the data model is the opposite axis: justdb is local-first Postgres-via-Rust because DB credentials are sensitive; justnotetaking is cloud-first D1-via-Hono because cross-device sync is the point. The Tauri shell consumes the same HTTP API the browser does — the only runtime difference is how the auth token is transported (cookie vs. bearer).

This plan is the path from `main` (the Next.js scaffold + the in-memory JustNotes canvas at commit `71fb28b`) to a shippable v1.

---

## Phasing overview

| Phase | Outcome | Key risk |
| --- | --- | --- |
| 0 | Monorepo scaffold; all four surfaces boot; anonymous Better Auth session works in browser + Tauri | scope; first time mixing Tauri + Hono + Better Auth |
| 1 | Notes persist to D1 via Hono; sync engine handles offline + multi-tab | sync conflict semantics |
| 2 | FTS5 powers ambient recall; server-side time scrub; viewport-bounded reads | none significant |
| 3 | OAuth sign-in surfaces (Google); anon → real account auto-linking lights up | OAuth-in-Tauri redirect ergonomics |
| 4 | Code signing, auto-update, prod domains, marketing site live | code signing, auto-update infra |

Each phase is independently shippable. Phase 0 alone is "the canvas, but on the right stack." Phase 1 is the first version anyone would actually use day-to-day. Phase 3 unlocks multi-device.

---

## Decisions locked before Phase 0

| Decision | Choice | Why |
| --- | --- | --- |
| Frontend framework | Vite 6 + React 19 | Drop Next.js; the app has no SSR benefit. Vite for fast dev, React 19 for parity with justdb. |
| CSS | Tailwind 4 | User explicit. Diverges from justdb's Tailwind 3 — acceptable, no shared UI today. |
| API framework | Hono | Best-in-class on Workers; Better Auth has a first-class Hono integration; RPC client gives end-to-end types. |
| Database | Cloudflare D1 | SQLite at the edge. FTS5 powers ambient recall cheaply. One shared DB partitioned by `user_id` (NOT per-user DBs). |
| ORM | Drizzle | Best-tested D1 path; Better Auth's Drizzle adapter is mature; `drizzle-kit` for migrations. |
| Auth | Better Auth + `anonymous()` + `bearer()` + `emailAndPassword()` | Anonymous plugin gives every visitor a real session+user row immediately, auto-links to a real account on sign-in. Bearer plugin handles Tauri's keychain transport. |
| Marketing | Astro on Cloudflare Pages | Mirrors justdb's `apps/marketing` choice. Static-first, room for content. |
| Desktop shell | Tauri 2 | Mandatory from day one (not deferred). Wraps the Vite build, consumes the same Hono API over HTTPS. |
| Repo | In-place on `migrate/v2` branch | Single commit history; Next.js scaffold removed once the new layout boots. |

---

## Layout (post-Phase 0)

```
justnotetaking/
├── apps/
│   ├── web/         # Vite 6 + React 19 + Tailwind 4 (lifted JustNotes components)
│   ├── api/         # Hono on Cloudflare Workers + Drizzle + Better Auth
│   └── marketing/   # Astro on Cloudflare Pages
├── packages/
│   └── api-client/  # Hono RPC client (hc<AppType>) shared across apps + src-tauri
├── src-tauri/       # Tauri 2 shell wrapping apps/web
├── docs/
│   └── migration.md # this file
├── pnpm-workspace.yaml
└── package.json
```

---

## Phase 0 — Monorepo scaffold

Build the shape. No notes persist yet — the canvas still seeds from `SEED` on mount. But every visitor (browser or Tauri) gets a real Better Auth session backed by a `user` row in D1, the Hono API is reachable, and the marketing site renders.

### apps/web

- Vite 6 + React 19 (matches `apps/web` in `../justdb`)
- Tailwind 4 via `@tailwindcss/vite` (NOT the old PostCSS plugin path)
- Lift `src/components/JustNotes/*` verbatim — components are framework-agnostic React, no Next imports
- Replace `next/font/google` with `@fontsource-variable/{ibm-plex-sans, ibm-plex-mono, newsreader}` — same families, self-hosted, identical CSS variable wiring
- New entry: `index.html` + `src/main.tsx` + `src/App.tsx` (App renders `<JustNotes />` plus a `<BetterAuthBootstrap />` that ensures an anon session)

### apps/api

- Hono on Cloudflare Workers, `wrangler dev` for local
- `wrangler.toml` with D1 binding `DB` → `justnotetaking-dev` (local) and `justnotetaking-prod` (remote, created in Phase 4)
- Drizzle schema in `src/db/schema.ts`:
  - Better Auth tables: `user`, `session`, `account`, `verification` (generated via Better Auth CLI)
  - `notes` table is added in Phase 1, not Phase 0
- Better Auth instance in `src/auth.ts`:
  ```ts
  export const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    plugins: [anonymous(), bearer(), emailAndPassword()],
    // OAuth providers commented in but disabled until Phase 3
  });
  ```
- Hono mount:
  ```ts
  app.on(["POST", "GET"], "/api/auth/**", c => auth.handler(c.req.raw));
  ```
- Session middleware attaches `c.var.session` and `c.var.user` to every other route
- CORS configured for `apps/web` dev origin (`http://localhost:5173`) and Tauri's webview origin

### packages/api-client

- Workspace package exporting `createClient({ baseUrl, getBearerToken? })` wrapping `hc<AppType>(baseUrl, { headers })`
- Single source of truth for API shape — re-exports `AppType` from `apps/api`
- Browser: `getBearerToken` undefined, cookies handle session
- Tauri: `getBearerToken` reads from OS keychain, attaches `Authorization: Bearer ...` on every request
- One implementation; runtime decides transport

### apps/marketing

- Astro 5, Tailwind 4 via Vite plugin (the legacy `@astrojs/tailwind` integration is v3-only — use the Vite plugin directly through Astro's `vite.plugins` config)
- Initial pages: `/` (landing stub, "justnotetaking — spatial notes on a dark canvas"), `/auth/callback` (empty OAuth redirect target — wired in Phase 3)
- Cloudflare Pages deploy target (Phase 4)

### src-tauri

- Tauri 2 + Rust
- `tauri.conf.json`:
  - `frontendDist` → `../apps/web/dist`
  - `beforeDevCommand` → `pnpm --filter @justanotetaker/web dev`
  - `devUrl` → `http://localhost:5173`
- Bearer-token storage: **decide between `tauri-plugin-stronghold` (encrypted file in app data dir) and the `keyring` crate (OS-native keychain)** during Phase 0 — leaning `keyring` for true OS integration on macOS
- Phase 0 only needs Tauri to open a window with the canvas + obtain an anonymous session via bearer token — no notes wiring

### Auth bootstrap

- On `apps/web` mount, `<BetterAuthBootstrap />` checks `getSession()`; if null, calls `signIn.anonymous()` and waits
- In Tauri, the same component runs — but the api-client's `getBearerToken` returns the keychain-stored token (or null on first run, which triggers anon sign-in and stores the returned token)
- After this, every API call has a session — no anonymous-vs-signed-in branching in app code

### Acceptance

- `pnpm dev` boots Vite at `:5173`, canvas works identically to current `main`
- `pnpm --filter @justanotetaker/api dev` runs Hono Worker at `:8787`; `POST /api/auth/sign-in/anonymous` returns a session and creates a row in `user`
- `pnpm --filter @justanotetaker/marketing dev` runs Astro at `:4321`
- `pnpm tauri:dev` opens a native window pointed at the Vite app, obtains an anonymous session on first boot, persists the bearer token, reuses it on subsequent launches
- `wrangler d1 migrations apply justnotetaking-dev --local` applies Better Auth's generated schema cleanly
- All four surfaces share TypeScript types via `packages/api-client`
- Legacy Next.js files (`src/app/`, `next.config.ts`, `next-env.d.ts`, root tsconfig.json, root postcss.config.mjs, root eslint.config.mjs) are removed
- Phase 0 lands as a coherent sequence of commits (one per sub-scaffold + a verification commit), not a single squash — keeps blast radius small if a step regresses

---

## Phase 1 — Notes persistence + sync

Replace in-memory `useState<Note[]>` with a real round-trip to D1.

### Schema

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  t INTEGER NOT NULL,             -- the "moment" used for recency + scrub
  text TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,    -- LWW key, server-assigned on every write
  deleted_at INTEGER              -- soft delete; clients filter, server keeps until cleanup
);
CREATE INDEX notes_user_updated ON notes(user_id, updated_at);
```

Settings (`Tweaks`) get either their own table or a JSON column on `user`. Decide during Phase 1.

### Hono routes (all gated by session middleware)

| Route | Purpose |
| --- | --- |
| `GET /api/notes` | List user's notes; optional `?since=<ts>` for delta sync |
| `POST /api/notes` | Create — body: `{ x, y, text, t }`; server assigns `id`, `updated_at` |
| `PATCH /api/notes/:id` | Partial update (text, x, y, t) |
| `DELETE /api/notes/:id` | Soft delete (`deleted_at = NOW()`) |

### Client

- New `lib/storage.ts` defines a `Storage` interface (`list`, `create`, `update`, `delete`)
- `RemoteStorage` implements it via the api-client; queued writes, LWW on `updated_at`
- React app calls `storage.list()` on mount; if empty AND this is the first session (no `user.metadata.seeded`), seeds with `SEED` and marks `seeded = true`
- The existing `useState<Note[]>` becomes a derived view over `storage`

### Sync semantics

- LWW: highest `updated_at` wins on conflict
- Soft delete via `deleted_at`; clients filter it out, server preserves until a Phase 4 cleanup job
- Per-tab pending-write queue; on reconnect, drain in order
- No offline editing yet — Phase 2/3 territory if needed

### Acceptance

- Notes survive a hard refresh in the browser, in the Tauri shell, and across the two
- Two browser tabs both edit the same note: last commit wins, no rows lost, no zombie notes
- Anonymous user has notes; clearing cookies / keychain forfeits them (expected)
- `SEED` only appears once per fresh user — second visit shows whatever's actually there

---

## Phase 2 — Server-side recall

Move ambient recall + time scrub off the client-side `.includes()` filter (`JustNotes.tsx:336`) and onto FTS5.

### Schema

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(text, content='notes', content_rowid='rowid');
-- triggers to keep the index in sync with notes
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
```

### Hono routes

| Route | Purpose |
| --- | --- |
| `GET /api/notes/search?q=` | FTS5 match, returns ranked note ids + snippets |
| `GET /api/notes?before=<ts>` | Time scrub: notes with `t <= before` |
| `GET /api/notes?bbox=x1,y1,x2,y2` | Viewport-bounded read (possibly defer to Phase 2.5 if not yet a real problem) |

### Client

- `AmbientBar`'s debounced search call replaces the in-memory filter
- `TimeScrub` calls the server on thumb-release; intermediate movement still uses the in-memory data
- Initial canvas load fetches all the user's notes; ongoing reads are bounded

### Acceptance

- Ambient recall stays under 50ms for 10k-note datasets (locally measurable with `wrangler dev`'s D1)
- Time scrub feels instant for any user under ~50k notes
- No client-side `.includes()` filter remains in the recall path

---

## Phase 3 — Sign-in surfaces

Bring the dormant OAuth flows alive.

### Web

- `/sign-in` route in `apps/web` with Google OAuth + email/password
- Better Auth's `anonymous()` plugin auto-links the anonymous user_id to the real one on sign-in — no manual `UPDATE notes SET user_id = ?` script
- "Sign in to sync across devices" CTA in the chrome (replaces the always-on `chrome-bl` hint)

### Tauri

OAuth callback can't land in the Tauri webview directly — Tauri uses a custom protocol (`tauri://`) that OAuth providers won't redirect to. Two viable patterns:

1. **System-browser handoff + deep link** (preferred):
   - Tauri opens the system browser to `https://justanotetaker.kreativekorna.com/auth/start?desktop=1`
   - That route runs the standard OAuth flow, exchanges the code for a bearer token, then deep-links back to `justnotetaking://auth/callback?token=...`
   - Tauri stores the bearer token in OS keychain

2. **Local listener** (fallback):
   - `tauri-plugin-oauth` spins up a one-shot localhost listener
   - Use only if deep links prove unreliable (some Linux desktop environments fight them)

### Astro

- Marketing site adds a "Get justnotetaking" button → Tauri release page + a "Try in browser" button → web app
- `/auth/start` and `/auth/callback` live in `apps/web` (or `apps/api`), not Astro

### Acceptance

- Browser user signs in with Google; all their anonymous notes follow them in
- Tauri user signs in via system browser; returns to a logged-in window; notes follow them in
- Both runtimes can sign out cleanly (clears session + keychain entry)

---

## Phase 4 — Ship

| Track | Work |
| --- | --- |
| Tauri | Apple Developer ID signing, notarization, auto-update via `tauri-plugin-updater`, GitHub Releases as the update feed |
| Workers | Production `wrangler.toml`, custom domain (`api.justanotetaker.kreativekorna.com`), secrets via `wrangler secret put` |
| D1 | Production DB created via `wrangler d1 create justnotetaking-prod`, migrations run via `wrangler d1 migrations apply --remote` |
| Marketing | Astro deployed to Cloudflare Pages, custom domain (`justanotetaker.kreativekorna.com`) |
| Observability | Wrangler analytics, Cloudflare Workers Logs for API errors, basic crash reporting for Tauri (Sentry or self-hosted) |
| Cleanup | Soft-deleted rows past 30 days purged via a scheduled Worker |

---

## Open decisions deferred from planning

These don't block Phase 0 but need answers before later phases:

- **OAuth providers** — Google for sure. GitHub? Magic-link via email?
- **Settings storage** — separate `settings` table, or a `user.metadata` JSON column?
- **Per-note conflict resolution beyond LWW** — needed before any collaborative/shared notes feature
- **Tauri keychain plugin** — `tauri-plugin-stronghold` (encrypted file in app data dir) vs the `keyring` crate (OS-native keychain) vs `tauri-plugin-keyring`. Leaning `keyring` for true OS integration.
- **Hosted SaaS path** — justdb has both a hosted Next.js SaaS and a Tauri build from the same repo. justnotetaking' Astro marketing + Vite web app already cover the "try in browser" surface. Confirm we don't also want a second hosted variant.

---

## Anti-goals (things we explicitly are NOT doing)

- **No Next.js anywhere.** The Astro marketing site replaces any need for Next-style SSR pages.
- **No Postgres.** D1 is the only database. Don't lift `postgres.rs` from justdb.
- **No hand-rolled auth.** Better Auth owns sessions, OAuth, anonymous identity, and account linking.
- **No `invoke()` for data.** The Tauri shell talks to the same HTTP API as the browser — never RPC into Rust for note CRUD.
- **No per-user D1 databases.** One shared DB with `user_id` partitioning.
- **No literal "one markdown file per note" persistence.** The help-foot copy stays as aspirational design language; if true file portability is later required, ship it as a `.zip` export feature on top of D1, not as the canonical store.
