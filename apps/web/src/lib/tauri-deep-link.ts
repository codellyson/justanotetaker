import { isTauri, API_BASE_URL } from "./runtime";

// Tauri-only deep-link wiring. The server's /api/auth/desktop-callback
// returns HTML that navigates to:
//
//   justnotes://auth/callback?token=<bearer>
//
// The OS hands that URL to our app via tauri-plugin-deep-link. We pull
// the token out, persist it to OS keychain via the existing Rust
// command, then reload the webview so the bearer-mode auth client picks
// it up on the very first fetch of the new page lifecycle.
//
// Returns a teardown function so callers can detach the listener.

type CleanupFn = () => void;

export async function attachDeepLinkListener(): Promise<CleanupFn> {
  if (!isTauri) return () => {};

  const [{ onOpenUrl, getCurrent }, { invoke }] = await Promise.all([
    import("@tauri-apps/plugin-deep-link"),
    import("@tauri-apps/api/core"),
  ]);

  const handleUrl = async (urls: string[]) => {
    for (const url of urls) {
      const token = parseCallbackToken(url);
      if (!token) continue;
      try {
        await invoke("store_bearer_token", { token });
      } catch (err) {
        console.error("[deep-link] keychain write failed", err);
        continue;
      }
      // Reload so AuthBootstrap re-runs and the bearer-mode auth client
      // sees the new token on its first request.
      window.location.reload();
      return;
    }
  };

  // If the app was launched FROM a deep link (cold start, OS hands the
  // URL to the brand-new process), getCurrent returns it. Hot launches
  // get the URL via onOpenUrl below.
  try {
    const cold = await getCurrent();
    if (cold && cold.length > 0) await handleUrl(cold);
  } catch (err) {
    console.error("[deep-link] getCurrent failed", err);
  }

  const unsubscribe = await onOpenUrl(handleUrl);
  return unsubscribe;
}

function parseCallbackToken(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "justnotes:") return null;
    // Accept either /auth/callback or //auth/callback path shapes; URL
    // parser handles them differently depending on the host vs path
    // interpretation of the protocol.
    if (!u.pathname.endsWith("/callback") && !u.host.endsWith("auth")) return null;
    return u.searchParams.get("token");
  } catch {
    return null;
  }
}

// URL the user should be sent to (in the system browser) to start an
// OAuth dance that ends in our desktop callback. Provider is passed
// through to Better Auth's /api/auth/sign-in/social.
export function buildDesktopOAuthUrl(provider: "google"): string {
  const callbackURL = `${API_BASE_URL}/api/auth/desktop-callback`;
  const params = new URLSearchParams({ provider, callbackURL });
  return `${API_BASE_URL}/api/auth/sign-in/social?${params.toString()}`;
}

export async function openInSystemBrowser(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
