import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";

type Mode = "sign-in" | "sign-up";

export function AuthPanel({
  open,
  onClose,
  hasGoogle,
}: {
  open: boolean;
  onClose: () => void;
  hasGoogle: boolean;
}) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

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
      await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.origin + "/",
      });
      // signIn.social redirects to Google; nothing else to do.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="focus-shroud"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).classList.contains("focus-shroud")) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="auth-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="auth-head">
          <span className="auth-title">
            {mode === "sign-in" ? "sign in" : "create an account"}
          </span>
          <button className="auth-x" aria-label="close" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="auth-sub">
          {mode === "sign-in"
            ? "sync your notes across devices."
            : "your current notes will follow you in."}
        </p>

        <form onSubmit={onSubmit} className="auth-form">
          {mode === "sign-up" && (
            <label className="auth-field">
              <span>name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="optional"
                autoComplete="name"
              />
            </label>
          )}
          <label className="auth-field">
            <span>email</span>
            <input
              ref={firstFieldRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label className="auth-field">
            <span>password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "…" : mode === "sign-in" ? "sign in" : "create account"}
          </button>
        </form>

        {hasGoogle && (
          <>
            <div className="auth-or">
              <span />
              <em>or</em>
              <span />
            </div>
            <button className="auth-google" onClick={onGoogle} disabled={busy}>
              continue with google
            </button>
          </>
        )}

        <button
          className="auth-toggle"
          onClick={() => {
            setError(null);
            setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"));
          }}
        >
          {mode === "sign-in" ? "no account? create one →" : "have an account? sign in →"}
        </button>
      </div>
    </div>
  );
}
