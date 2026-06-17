import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";
import { API_BASE_URL, isTauri } from "./runtime";

// Browser: cookie-based sessions. Same-origin requests carry cookies via
// credentials: "include", and Better Auth's React store reads the session
// straight from /api/auth/get-session.
//
// Tauri: bearer-based sessions. Cookies don't reliably round-trip from
// the API origin into the Tauri webview's storage, and OAuth callbacks
// from the system browser can't land in the webview at all. We mirror
// the same useSession() interface but back it with the OS keychain:
//   - onRequest injects Authorization: Bearer <token> from `get_bearer_token`
//   - onResponse stores any `set-auth-token` header via `store_bearer_token`
// Sign-in / sign-up / sign-out all flow through the regular client; the
// keychain just shadows them so subsequent requests carry the right token.

let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (!isTauri) return null;
  if (tauriInvoke) return tauriInvoke;
  const { invoke } = await import("@tauri-apps/api/core");
  tauriInvoke = invoke as unknown as typeof tauriInvoke;
  return tauriInvoke;
}

async function readKeychainToken(): Promise<string | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return (await invoke("get_bearer_token")) as string | null;
  } catch (err) {
    console.error("[auth] keychain read failed", err);
    return null;
  }
}

async function writeKeychainToken(token: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke("store_bearer_token", { token });
  } catch (err) {
    console.error("[auth] keychain write failed", err);
  }
}

export async function clearKeychainToken(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke("clear_bearer_token");
  } catch (err) {
    console.error("[auth] keychain clear failed", err);
  }
}

const tauriFetchOptions = {
  // Bearer transport. No cookies on Tauri requests.
  credentials: "omit" as const,
  auth: {
    type: "Bearer" as const,
    token: async () => (await readKeychainToken()) ?? "",
  },
  onSuccess: async (ctx: { response: Response }) => {
    // Better Auth's bearer plugin sets `set-auth-token` on any response
    // that minted a new session. Shadow that into the keychain so the
    // next request picks it up. Also fires on anonymous sign-in, so the
    // first request after install populates the token automatically.
    const next = ctx.response.headers.get("set-auth-token");
    if (next) await writeKeychainToken(next);
  },
};

const browserFetchOptions = {
  credentials: "include" as const,
};

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  fetchOptions: isTauri ? tauriFetchOptions : browserFetchOptions,
  plugins: [anonymousClient()],
});

export type AuthClient = typeof authClient;
