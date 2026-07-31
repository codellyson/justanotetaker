// Runtime detection. The Tauri webview injects __TAURI_INTERNALS__ on the
// window before any user JS runs. We only need to know which runtime we
// are in for transport decisions (cookies vs bearer tokens later).
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Build-time env. VITE_API_BASE_URL wins if set — lets prod and preview
// builds target different Workers (e.g. staging.api.…) without code
// changes. The fall-back keeps prod working out of the box and dev on
// the wrangler dev default.
export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.PROD
    ? "https://api.justanotetaker.kreativekorna.com"
    : "http://localhost:8787");

// Share links need an explicit web origin — window.location.origin is
// tauri://localhost on desktop.
export const WEB_BASE_URL =
  (import.meta.env.VITE_WEB_BASE_URL as string | undefined) ??
  (import.meta.env.PROD
    ? "https://app.justanotetaker.kreativekorna.com"
    : "http://localhost:5173");
