import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, hasGoogleProvider } from "./auth";
import type { Env } from "./env";
import { notesRoutes } from "./routes/notes";
import { settingsRoutes } from "./routes/settings";

const app = new Hono<Env>();

// CORS for the web dev origin and the Tauri webview. Permissive in dev,
// tightened to known origins in Phase 4.
app.use("*", cors({
  origin: (origin) => origin ?? "*",
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
