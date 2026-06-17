import { createClient } from "@justnotes/api-client";
import { API_BASE_URL, isTauri } from "./runtime";

// In Tauri we pull the bearer token from the OS keychain on every
// request. The Rust command is the same one Better Auth's onSuccess
// writes to from auth-client.ts, so notes/settings/etc. carry whatever
// token the most recent auth response minted.
let cachedInvoke: ((cmd: string) => Promise<unknown>) | null = null;
async function readBearer(): Promise<string | null> {
  if (!isTauri) return null;
  if (!cachedInvoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    cachedInvoke = invoke as unknown as typeof cachedInvoke;
  }
  try {
    return ((await cachedInvoke!("get_bearer_token")) as string | null) ?? null;
  } catch {
    return null;
  }
}

export const api = createClient({
  baseUrl: API_BASE_URL,
  getBearerToken: isTauri ? readBearer : undefined,
});
