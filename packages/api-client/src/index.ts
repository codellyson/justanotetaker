import { hc } from "hono/client";
import type { AppType } from "@justnotes/api";

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
      return fetch(input, {
        ...init,
        headers,
        // Cookies in the browser; bearer tokens in Tauri. Don't mix.
        credentials: getBearerToken ? "omit" : "include",
      });
    },
  });
}

export type ApiClient = ReturnType<typeof createClient>;
export type { AppType };
