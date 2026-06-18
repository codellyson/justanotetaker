import { useState, type FormEvent } from "react";
import { Button, Field, Modal } from "@codellyson/justui/react";
import { authClient } from "../lib/auth-client";
import { isTauri } from "../lib/runtime";
import { signInWithProviderInTauri } from "../lib/tauri-oauth";

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
        // Resolves when the localhost listener has the token + we've
        // persisted it. The reload follows immediately, so any code
        // after this awaits won't run.
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
    <Modal
      open={open}
      onClose={onClose}
      title={mode === "sign-in" ? "sign in" : "create an account"}
      description={
        mode === "sign-in"
          ? "sync your notes across devices."
          : "your current notes will follow you in."
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
          autoFocus
          required
          autoComplete="email"
        />
        <Field
          label="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          error={error}
        />
        <Button type="submit" disabled={busy} className="mt-1">
          {busy ? "…" : mode === "sign-in" ? "sign in" : "create account"}
        </Button>
      </form>

      {hasGoogle && (
        <>
          <div className="mt-1 flex items-center gap-2.5 font-mono text-[10.5px] text-muted">
            <span className="h-px flex-1 bg-border" />
            <em className="not-italic">or</em>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="secondary" onClick={onGoogle} disabled={busy}>
            continue with google
          </Button>
        </>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"));
        }}
        className="self-start px-0 font-mono"
      >
        {mode === "sign-in" ? "no account? create one →" : "have an account? sign in →"}
      </Button>
    </Modal>
  );
}
