import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, type Auth, type AuthEnv } from "./auth";

type Bindings = AuthEnv;

type Variables = {
  auth: Auth;
  user: Auth extends { $Infer: { Session: { user: infer U } } } ? U | null : unknown;
  session: Auth extends { $Infer: { Session: { session: infer S } } } ? S | null : unknown;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
  c.set("user", (result?.user ?? null) as Variables["user"]);
  c.set("session", (result?.session ?? null) as Variables["session"]);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({ user });
});

export default app;

export type AppType = typeof app;
