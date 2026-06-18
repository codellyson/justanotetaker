import { isTauri, API_BASE_URL } from "./runtime";

// Tauri OAuth via the localhost-listener pattern (RFC 8252 for native
// apps). We don't use a custom URL scheme like justnotes:// because
// macOS only registers schemes for bundled, installed .app's — dev
// iteration with `tauri:dev` would otherwise need a fresh bundle +
// drag-to-Applications cycle every change. Localhost listener works
// uniformly in dev + prod, on every platform.
//
// Flow (kicked off by signInWithGoogle below):
//   1. JS asks Rust to start a one-shot HTTP listener on an ephemeral
//      port (tauri-plugin-oauth handles the actual socket).
//   2. JS opens the system browser to /api/desktop-oauth-start?listener=<port>.
//   3. Server completes the OAuth dance with Better Auth.
//   4. Server 302s the browser to http://localhost:<port>/?token=<jwt>.
//   5. The listener catches it; Rust emits an "oauth://callback" event
//      carrying the full URL.
//   6. JS extracts the token, persists to OS keychain via the existing
//      store_bearer_token command, and reloads the webview so the
//      bearer-mode auth client picks it up on the first request.

type CleanupFn = () => void;

let tauriApi: typeof import("@tauri-apps/api/core") | null = null;
let eventApi: typeof import("@tauri-apps/api/event") | null = null;

async function loadTauri() {
  if (!isTauri) return null;
  if (!tauriApi) tauriApi = await import("@tauri-apps/api/core");
  if (!eventApi) eventApi = await import("@tauri-apps/api/event");
  return { invoke: tauriApi.invoke, listen: eventApi.listen };
}

async function openInSystemBrowserTauri(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function openInSystemBrowser(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await openInSystemBrowserTauri(url);
}

function parseCallbackToken(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * Run the full Tauri-mode OAuth dance for a provider. Resolves when the
 * token is persisted to keychain (just before the page reloads). Throws
 * if the listener can't start or the user closes the browser before the
 * callback fires (latter manifests as a hanging promise — caller should
 * apply its own timeout if it cares).
 */
export async function signInWithProviderInTauri(provider: "google"): Promise<void> {
  const tauri = await loadTauri();
  if (!tauri) throw new Error("not running in Tauri");

  const port = (await tauri.invoke("start_oauth_listener")) as number;

  const done = new Promise<void>((resolve, reject) => {
    let unlisten: CleanupFn | null = null;
    tauri.listen<string>("oauth://callback", async (event) => {
      try {
        const token = parseCallbackToken(event.payload);
        if (!token) {
          unlisten?.();
          reject(new Error("oauth callback missing token"));
          return;
        }
        await tauri.invoke("store_bearer_token", { token });
        unlisten?.();
        // Reload so AuthBootstrap re-runs and the bearer-mode auth
        // client sees the new token on its first request.
        window.location.reload();
        resolve();
      } catch (err) {
        unlisten?.();
        reject(err);
      }
    }).then((u) => {
      unlisten = u;
    });
  });

  const startUrl =
    `${API_BASE_URL}/api/desktop-oauth-start` +
    `?provider=${encodeURIComponent(provider)}` +
    `&listener=${port}`;
  await openInSystemBrowserTauri(startUrl);

  await done;
}
