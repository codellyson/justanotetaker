import { useEffect, useRef, useState } from "react";
import { TweaksPanel } from "./tweaks";
import { listTokens, createToken, revokeToken, type ApiToken } from "../../lib/tokens";

const TOKENS_STYLE = `
  .tok-intro{color:rgb(var(--text-secondary));line-height:1.5}
  .tok-intro code{font-family:ui-monospace,monospace;font-size:10px;
    background:rgb(var(--bg) / .5);padding:1px 4px;border-radius:3px;color:rgb(var(--text-primary))}
  .tok-empty{color:rgb(var(--text-secondary));text-align:center;padding:10px 4px;line-height:1.5}

  .tok-new{display:flex;gap:6px}
  .tok-input{flex:1;min-width:0;appearance:none;font:inherit;
    background:rgb(var(--bg) / .5);color:rgb(var(--text-primary));
    border:.5px solid rgb(var(--border) / .7);border-radius:7px;padding:6px 9px;outline:none}
  .tok-input:focus{border-color:rgb(var(--accent))}
  .tok-btn{appearance:none;font:inherit;font-weight:600;white-space:nowrap;cursor:default;
    border:0;border-radius:7px;padding:6px 11px;
    background:rgb(var(--accent));color:rgb(var(--accent-contrast, 255 255 255))}
  .tok-btn:disabled{opacity:.5}
  .tok-btn.tok-ghost{background:rgb(var(--bg) / .5);color:rgb(var(--text-primary));
    border:.5px solid rgb(var(--border) / .7);font-weight:500}
  .tok-btn.tok-ghost:hover{background:rgb(var(--accent) / .14)}
  .tok-btn.tok-danger{background:transparent;color:rgb(var(--danger, 220 60 60));
    border:.5px solid rgb(var(--danger, 220 60 60) / .5);padding:4px 8px;font-weight:500}

  .tok-reveal{display:flex;flex-direction:column;gap:7px;padding:10px;
    border-radius:9px;background:rgb(var(--accent) / .12);
    border:.5px solid rgb(var(--accent) / .45)}
  .tok-reveal-t{font-weight:600;color:rgb(var(--text-primary))}
  .tok-reveal-warn{color:rgb(var(--text-secondary));font-size:10px;line-height:1.4}
  .tok-secret{display:flex;flex-direction:column;gap:6px}
  .tok-secret code{display:block;font-family:ui-monospace,monospace;font-size:10px;
    background:rgb(var(--bg) / .6);color:rgb(var(--text-primary));
    border:.5px solid rgb(var(--border) / .7);border-radius:6px;padding:6px 8px;
    overflow-x:auto;white-space:nowrap;user-select:all;
    scrollbar-width:thin;scrollbar-color:rgb(var(--border) / .7) transparent}
  .tok-secret .tok-btn{width:100%;text-align:center}

  .tok-list{display:flex;flex-direction:column;gap:6px}
  .tok-row{display:flex;align-items:center;gap:8px;padding:8px 10px;
    border-radius:9px;background:rgb(var(--bg) / .4);border:.5px solid rgb(var(--border) / .5)}
  .tok-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .tok-row-name{font-weight:600;color:rgb(var(--text-primary));
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tok-row-meta{color:rgb(var(--text-secondary));font-size:10px}
  .tok-row-meta code{font-family:ui-monospace,monospace}
`;

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function ApiTokensPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [armedRevoke, setArmedRevoke] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    listTokens()
      .then(setTokens)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // Reset transient UI each time the panel opens.
    return () => {
      setJustCreated(null);
      setArmedRevoke(null);
      setName("");
    };
  }, [open]);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function onCreate() {
    const n = name.trim();
    if (!n || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { token, secret } = await createToken(n);
      setTokens((prev) => [token, ...prev]);
      setJustCreated({ name: token.name, secret });
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function onCopy(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked — the field is user-select:all so they can copy manually
    }
  }

  async function onRevoke(id: string) {
    if (armedRevoke !== id) {
      setArmedRevoke(id);
      return;
    }
    setArmedRevoke(null);
    const prev = tokens;
    setTokens((ts) => ts.filter((t) => t.id !== id)); // optimistic
    try {
      await revokeToken(id);
    } catch (e) {
      setTokens(prev); // rollback
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <TweaksPanel open={open} onClose={onClose} title="API tokens">
      <style>{TOKENS_STYLE}</style>

      <p className="tok-intro">
        Personal tokens let a Claude agent pipe notes onto your canvas via the{" "}
        <code>justanotetaker</code> MCP server. Treat a token like a password.
      </p>

      {justCreated && (
        <div className="tok-reveal">
          <div className="tok-reveal-t">“{justCreated.name}” created</div>
          <div className="tok-secret">
            <code>{justCreated.secret}</code>
            <button className="tok-btn tok-ghost" onClick={() => onCopy(justCreated.secret)}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="tok-reveal-warn">
            Copy it now — it’s shown once and can’t be retrieved again.
          </div>
        </div>
      )}

      <div className="twk-sect">New token</div>
      <div className="tok-new">
        <input
          className="tok-input"
          placeholder="e.g. claude-code"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
        />
        <button className="tok-btn" disabled={!name.trim() || creating} onClick={() => void onCreate()}>
          {creating ? "…" : "Create"}
        </button>
      </div>

      <div className="twk-sect">Active tokens</div>
      {error && <div className="tok-row-meta" style={{ color: "rgb(var(--danger, 220 60 60))" }}>{error}</div>}
      {loading ? (
        <div className="tok-empty">loading…</div>
      ) : tokens.length === 0 ? (
        <div className="tok-empty">No tokens yet.</div>
      ) : (
        <div className="tok-list">
          {tokens.map((t) => (
            <div className="tok-row" key={t.id}>
              <div className="tok-row-main">
                <div className="tok-row-name">{t.name}</div>
                <div className="tok-row-meta">
                  <code>{t.prefix}…</code> · created {ago(t.createdAt)} ·{" "}
                  {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"}
                </div>
              </div>
              <button className="tok-btn tok-danger" onClick={() => void onRevoke(t.id)}>
                {armedRevoke === t.id ? "Confirm" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}
    </TweaksPanel>
  );
}
