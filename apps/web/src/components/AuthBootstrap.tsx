import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../lib/auth-client";

// Ensures every visitor — browser or Tauri — has a Better Auth session
// before the canvas renders. If no session exists, we sign in
// anonymously, which gives the user a real user_id and session under
// the hood. When they later sign in for real, Better Auth's anonymous
// plugin auto-links the rows. See docs/migration.md → "Auth posture".
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: session } = await authClient.getSession();
        if (!session && !cancelled) {
          await authClient.signIn.anonymous();
        }
      } catch (err) {
        // Fail open — the canvas still works without auth in Phase 0
        // because notes are still in-memory. Phase 1 will gate writes.
        console.error("[auth] bootstrap failed", err);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
