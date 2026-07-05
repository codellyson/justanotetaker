import { useEffect, useState, type FormEvent } from "react";
import { Button, Field } from "@codellyson/justui/react";
import { authClient } from "../lib/auth-client";
import { isTauri } from "../lib/runtime";
import { signInWithProviderInTauri } from "../lib/tauri-oauth";

type Mode = "sign-in" | "sign-up";

export function AuthPanel({
  open,
  onClose,
  hasGoogle,
  signedIn,
  identityLabel,
  accountEmail,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  hasGoogle: boolean;
  signedIn: boolean;
  identityLabel: string;
  accountEmail?: string;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-up") {
        const { error: err } = await authClient.signUp.email({
          email,
          password,
          name: name.trim() || email.split("@")[0],
        });
        if (err) throw new Error(err.message ?? "sign up failed");
      } else {
        const { error: err } = await authClient.signIn.email({ email, password });
        if (err) throw new Error(err.message ?? "sign in failed");
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isTauri) {
        await signInWithProviderInTauri("google");
      } else {
        await authClient.signIn.social({
          provider: "google",
          callbackURL: window.location.origin + "/",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <aside
      className={"auth-rail" + (open ? " open" : "")}
      aria-hidden={!open}
      aria-label="sign in"
    >
      <div className="auth-rail-inner">
        <header className="auth-rail-hd">
          <div className="auth-rail-brand">
            <span className="auth-rail-dot" />
            <span className="auth-rail-wordmark">justanotetaker</span>
          </div>
          <button
            type="button"
            className="auth-rail-x"
            onClick={onClose}
            aria-label="close"
          >
            ✕
          </button>
        </header>

        {signedIn ? (
          <>
            <div className="auth-rail-headline">
              <h2>you’re signed in.</h2>
              <p>your canvas syncs across devices.</p>
            </div>
            <div className="auth-account">
              <div className="auth-account-id">
                <span className="auth-account-name">{identityLabel || "your account"}</span>
                {accountEmail && accountEmail !== identityLabel && (
                  <span className="auth-account-email">{accountEmail}</span>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={onSignOut} className="w-full">
                sign out
              </Button>
            </div>
          </>
        ) : (
        <>
        <div className="auth-rail-headline">
          <h2>{mode === "sign-in" ? "welcome back." : "make a home for your notes."}</h2>
          <p>
            {mode === "sign-in"
              ? "sync your canvas across devices."
              : "your current notes will follow you in."}
          </p>
        </div>

        <form onSubmit={onSubmit} className="auth-form">
          {mode === "sign-up" && (
            <Field
              label="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="optional"
              autoComplete="name"
            />
          )}
          <Field
            label="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@somewhere"
          />
          <Field
            label="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            placeholder="at least 8 characters"
            error={error}
          />
          <Button type="submit" size="sm" disabled={busy} className="mt-1 w-full">
            {busy ? "…" : mode === "sign-in" ? "sign in" : "create account"}
          </Button>
        </form>

        {hasGoogle && (
          <div className="auth-google">
            <div className="auth-divider">
              <span />
              <em>or</em>
              <span />
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={onGoogle}
              disabled={busy}
              className="w-full"
            >
              <GoogleGlyph /> continue with google
            </Button>
          </div>
        )}

        <div className="auth-footer">
          <button
            type="button"
            className="auth-switch"
            onClick={() => {
              setError(null);
              setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"));
            }}
          >
            {mode === "sign-in" ? "new here? create an account" : "already have one? sign in"}
          </button>
        </div>
        </>
        )}
      </div>
    </aside>
  );
}

function GoogleGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 18 18"
      aria-hidden="true"
      className="inline-block align-[-2px] mr-1.5"
    >
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.13 4.13 0 0 1-1.79 2.71v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.87-3.06.87a5.35 5.35 0 0 1-5.02-3.7H.97v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.98 10.73a5.36 5.36 0 0 1 0-3.46V4.94H.97a9 9 0 0 0 0 8.12l3-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.45 1.35l2.58-2.58A9 9 0 0 0 .97 4.94l3 2.33A5.35 5.35 0 0 1 9 3.58z"/>
    </svg>
  );
}
