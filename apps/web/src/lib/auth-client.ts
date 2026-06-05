import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";
import { API_BASE_URL } from "./runtime";

// Phase 0: cookie-based sessions for both browser and Tauri. Tauri's
// webview can hold cookies for the API origin via CORS + credentials.
// If prod cookie semantics don't hold up in Tauri, the bearer plugin
// is already on the server — swap transports here, no UI changes needed.
export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  fetchOptions: {
    credentials: "include",
  },
  plugins: [anonymousClient()],
});

export type AuthClient = typeof authClient;
