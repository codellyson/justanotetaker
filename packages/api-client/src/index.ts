import { hc } from "hono/client";
import type { AppType } from "@justanotetaker/api";

export type CreateClientOpts = {
  baseUrl: string;
  // Browser: omit — cookies handle session.
  // Tauri: provide a getter that reads the bearer token from OS keychain.
  getBearerToken?: () => string | null | Promise<string | null>;
};

export function createClient({ baseUrl, getBearerToken }: CreateClientOpts) {
  return hc<AppType>(baseUrl, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (getBearerToken) {
        const token = await getBearerToken();
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
      // keepalive lets a write fired during pagehide outlive the tab (the
      // unsynced-edit flush). Browsers cap keepalive bodies at 64KB and reject
      // over it, so only small payloads opt in; big ones keep normal fetch.
      const body = init?.body;
      const keepalive = typeof body === "string" && body.length < 60_000 ? true : undefined;
      return fetch(input, {
        ...init,
        headers,
        keepalive,
        // Cookies in the browser; bearer tokens in Tauri. Don't mix.
        credentials: getBearerToken ? "omit" : "include",
      });
    },
  });
}

export type ApiClient = ReturnType<typeof createClient>;
export type { AppType };
