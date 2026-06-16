import { useEffect, useRef, type ReactNode } from "react";
import { authClient } from "../lib/auth-client";

// Guarantees a session exists whenever children render. On first mount
// and any time the session transitions to null (e.g. after sign-out),
// we kick off an anonymous sign-in. useSession's store updates as soon
// as the cookie lands, so children unblock as soon as a session exists
// — anon or real, the canvas doesn't care.
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const creatingRef = useRef(false);

  useEffect(() => {
    if (isPending) return;
    if (session) return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    authClient.signIn
      .anonymous()
      .catch((err) => console.error("[auth] anonymous sign-in failed", err))
      .finally(() => {
        creatingRef.current = false;
      });
  }, [session, isPending]);

  if (isPending || !session) return null;
  return <>{children}</>;
}
