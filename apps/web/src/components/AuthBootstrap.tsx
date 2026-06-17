import { useEffect, useRef, useState, type ReactNode } from "react";
import { authClient } from "../lib/auth-client";
import { API_BASE_URL } from "../lib/runtime";
import { attachDeepLinkListener } from "../lib/tauri-deep-link";

// Guarantees a session exists whenever children render. On first mount
// and any time the session transitions to null (e.g. after sign-out),
// we kick off an anonymous sign-in. useSession's store updates as soon
// as the cookie lands, so children unblock as soon as a session exists
// — anon or real, the canvas doesn't care.
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const creatingRef = useRef(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    if (session) return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    setLastError(null);
    authClient.signIn
      .anonymous()
      .then((res) => {
        if (res && "error" in res && res.error) {
          const msg = (res.error as { message?: string }).message ?? "sign-in returned an error";
          setLastError(msg);
          console.error("[auth] anonymous sign-in returned error", res.error);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        console.error("[auth] anonymous sign-in failed", err);
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [session, isPending]);

  // Tauri: listen for the justnotes:// deep link that wraps the OAuth
  // bearer token from the system browser. No-op in the browser build.
  useEffect(() => {
    let detach: (() => void) | null = null;
    attachDeepLinkListener()
      .then((fn) => {
        detach = fn;
      })
      .catch((err) => console.error("[auth] deep-link setup failed", err));
    return () => {
      if (detach) detach();
    };
  }, []);

  if (isPending) return <BootScreen message="checking session…" />;
  if (!session) {
    return (
      <BootScreen
        message={lastError ? `couldn't reach the api` : "signing you in…"}
        detail={lastError ? `${lastError} · is ${API_BASE_URL} up?` : null}
      />
    );
  }
  return <>{children}</>;
}

function BootScreen({ message, detail }: { message: string; detail?: string | null }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "#0a0d12",
        color: "rgba(255,255,255,0.55)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        letterSpacing: "0.02em",
      }}
    >
      <div>{message}</div>
      {detail && <div style={{ color: "rgba(255,255,255,0.32)", fontSize: 11 }}>{detail}</div>}
    </div>
  );
}
