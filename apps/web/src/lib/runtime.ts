// Runtime detection. The Tauri webview injects __TAURI_INTERNALS__ on the
// window before any user JS runs. We only need to know which runtime we
// are in for transport decisions (cookies vs bearer tokens later).
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const API_BASE_URL = import.meta.env.PROD
  ? "https://api.justnotes.kreativekorna.com"
  : "http://localhost:8787";
