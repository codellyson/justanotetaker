import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, hasGoogleProvider } from "./auth";
import type { Env } from "./env";
import { notesRoutes } from "./routes/notes";
import { previewRoutes } from "./routes/preview";
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
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
// The Tauri shell spins up an ephemeral localhost listener (via
// tauri-plugin-oauth) before kicking off the OAuth flow and passes
// the resulting port here as `?listener=…`. We POST to Better Auth's
// social sign-in (POST-only), forward its state cookie, and 302 the
// system browser to Google. The listener port travels with us via the
// callbackURL → eventually back to the localhost listener after the
// OAuth dance completes.
app.get("/api/desktop-oauth-start", async (c) => {
  const provider = c.req.query("provider") ?? "google";
  const listener = c.req.query("listener") ?? "";
  const callbackParams = listener ? `?listener=${encodeURIComponent(listener)}` : "";
  const callbackURL = `${c.env.BETTER_AUTH_URL}/api/desktop-callback${callbackParams}`;
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

  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) c.header("Set-Cookie", setCookie);

  return c.redirect(data.url, 302);
});

// Tauri OAuth handoff — finish.
//
// Better Auth bounces here at the tail of /api/auth/callback/<provider>;
// session is real and live in the system browser's cookie jar. We pull
// the bearer token and 302 to the Tauri-side localhost listener URL
// (passed in via ?listener=… from the start endpoint).
//
// If ?listener= is missing the user landed here without the desktop
// flow — fall back to a static "signed in" page so they at least see
// something useful.
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
  const listener = c.req.query("listener");
  if (listener && /^\d+$/.test(listener)) {
    const port = Number(listener);
    if (port > 0 && port < 65536) {
      return c.redirect(`http://localhost:${port}/?token=${encodeURIComponent(token)}`, 302);
    }
  }
  return c.html(`<!doctype html>
<meta charset="utf-8"><title>Signed in</title>
<body style="background:#0a0d12;color:rgba(255,255,255,0.7);font:13px ui-sans-serif,system-ui;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <p>signed in. you can close this tab.</p>
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
  .use("/api/preview/*", requireUser as any)
  .route("/api/notes", notesRoutes)
  .route("/api/settings", settingsRoutes)
  .route("/api/preview", previewRoutes);

export default app;

export type AppType = typeof routes;
