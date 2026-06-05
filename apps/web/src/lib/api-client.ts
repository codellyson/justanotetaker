import { createClient } from "@justnotes/api-client";
import { API_BASE_URL } from "./runtime";

// Phase 0: bearer token getter is undefined so the underlying fetch sends
// cookies via credentials: "include". When/if we switch Tauri to bearer
// tokens, this becomes:
//   getBearerToken: async () => await invoke<string | null>("get_bearer_token")
export const api = createClient({
  baseUrl: API_BASE_URL,
});
