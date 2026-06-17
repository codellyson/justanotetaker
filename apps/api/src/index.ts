import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, hasGoogleProvider } from "./auth";
import type { Env } from "./env";
import { notesRoutes } from "./routes/notes";
import { settingsRoutes } from "./routes/settings";

const app = new Hono<Env>();

// CORS. Driven by the TRUSTED_ORIGINS env var (comma-separated). In dev
// the var lists the localhost ports; in prod it lists the marketing +
// app domains. Requests from unknown origins get no CORS headers, which
// causes the browser to block the response — same outcome as a 403 but
// without the worker doing the work. Origins not in the list with no
// Origin header (curl, server-to-server) are still allowed through.
app.use("*", cors({
  origin: (origin, c) => {
    if (!origin) return origin;
    const raw = (c.env as { TRUSTED_ORIGINS?: string }).TRUSTED_ORIGINS ?? "";
    const allowed = raw.split(",").map((s: string) => s.trim()).filter(Boolean);
    return allowed.includes(origin) ? origin : null;
  },
  credentials: true,
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Better Auth owns /api/auth/** — sign-up, sign-in, anonymous, bearer, etc.
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session middleware for everything else. Stores auth, user, session on
// the request context so downstream routes don't re-create the instance.
app.use("*", async (c, next) => {
  const auth = createAuth(c.env);
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("auth", auth);
  c.set("user", (result?.user ?? null) as Env["Variables"]["user"]);
  c.set("session", (result?.session ?? null) as Env["Variables"]["session"]);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({
    user,
    providers: { google: hasGoogleProvider(c.env) },
  });
});

// Tauri OAuth handoff — start.
//
// System-browser navigations are GET, but Better Auth's
// /api/auth/sign-in/social is POST-only (it returns { url, redirect }
// for the React client to redirect to). So the desktop client can't
// hit Better Auth directly — we proxy: read provider from the query,
// POST to Better Auth ourselves, forward its Set-Cookie (the state
// cookie required for callback validation), then 302 the browser to
// the Google auth URL Better Auth returned.
app.get("/api/desktop-oauth-start", async (c) => {
  const provider = c.req.query("provider") ?? "google";
  const callbackURL = `${c.env.BETTER_AUTH_URL}/api/desktop-callback`;
  const auth = createAuth(c.env);

  const upstream = await auth.handler(
    new Request(`${c.env.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, callbackURL }),
    }),
  );
  if (!upstream.ok) {
    return c.text(`sign-in/social failed (${upstream.status})`, 500);
  }
  const data = (await upstream.json()) as { url?: string };
  if (!data.url) return c.text("no OAuth url returned", 500);

  // Forward Better Auth's state cookie so /api/auth/callback/google
  // can validate when Google bounces the user back.
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) c.header("Set-Cookie", setCookie);

  return c.redirect(data.url, 302);
});

// Tauri OAuth handoff — finish.
//
// Hit by Better Auth's /api/auth/callback/<provider> at the end of the
// OAuth dance via the callbackURL we set above. We read the session
// that's now active (cookie set in the system browser), pull out the
// session token, and return HTML that navigates to a justnotes:// URL
// the OS hands back to the Tauri app. The Tauri side stores the token
// in OS keychain and reloads its webview; the bearer-mode auth client
// then carries it on every subsequent request.
//
// Lives outside /api/auth so the specific route doesn't break Hono's
// trie matching for the /api/auth/** wildcard.
app.get("/api/desktop-callback", (c) => {
  const session = c.get("session") as { token?: string } | null;
  const token = session?.token;
  if (!token) {
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
       <body style="background:#0a0d12;color:#e8a13f;font:13px ui-monospace,monospace;padding:24px">
       <p>No session after OAuth callback. Close this window and try again.</p></body>`,
      401,
    );
  }
  const safe = encodeURIComponent(token);
  return c.html(`<!doctype html>
<meta charset="utf-8"><title>Signed in</title>
<body style="background:#0a0d12;color:rgba(255,255,255,0.7);font:13px ui-sans-serif,system-ui;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="text-align:center">
    <p>signed in. you can close this tab.</p>
    <p style="opacity:0.6;font-size:11.5px">returning you to justnotes…</p>
    <p style="opacity:0.4;font-size:11px;margin-top:24px">
      didn't auto-return? <a href="justnotes://auth/callback?token=${safe}" style="color:#e8a13f">click here</a>
    </p>
  </div>
  <script>setTimeout(function(){window.location.href='justnotes://auth/callback?token=${safe}';},150);</script>
</body>`);
});

// Auth gate for the domain routes. Anonymous sessions count — we only
// block when there's no session at all. Middleware is path-prefixed via
// .use("/path/*", mw) so the route types stay fully typed for the RPC
// client; wrapping each mount in its own sub-Hono erases the schema.
const requireUser = async (c: { get: (k: "user") => unknown; set: (k: "userId", v: string) => void; json: (o: unknown, s: number) => Response }, next: () => Promise<void>) => {
  const user = c.get("user") as { id?: string } | null;
  if (!user?.id) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", user.id);
  await next();
};

const routes = app
  .use("/api/notes/*", requireUser as any)
  .use("/api/settings/*", requireUser as any)
  .route("/api/notes", notesRoutes)
  .route("/api/settings", settingsRoutes);

export default app;

export type AppType = typeof routes;
