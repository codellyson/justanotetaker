// Bring-your-own-key AI for the web surface. The user supplies a provider key
// (Anthropic, OpenAI, or Google); calls go browser-direct, so the app never
// sees a token and there's nothing to meter. The desktop surface runs the local
// `claude` CLI instead (BYO-CLI-auth) — see src-tauri run_task. Mirrors justdb's
// provider dispatch; kept plain-text (no structured-output schema) since "ask"
// wants prose, not JSON.

export type AiProvider = "anthropic" | "openai" | "google" | "claude-cli";

export interface ProviderMeta {
  id: AiProvider;
  label: string;
  defaultModel: string;
  keyPlaceholder: string;
  models: string[];
  /**
   * A local, already-authenticated CLI agent (e.g. Claude Code) driven
   * headless — no API key. The settings form hides the key field and shows
   * detection status instead.
   */
  local?: boolean;
}

/** A local CLI agent this app can drive, and whether it's installed. */
export interface LocalAgentInfo {
  id: string;
  name: string;
  present: boolean;
  path?: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-5",
    keyPlaceholder: "sk-ant-...",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4o",
    keyPlaceholder: "sk-...",
    models: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "google",
    label: "Google (Gemini)",
    defaultModel: "gemini-2.5-flash",
    keyPlaceholder: "AIza...",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "claude-cli",
    label: "Local CLI agent (Claude Code)",
    defaultModel: "sonnet",
    keyPlaceholder: "",
    models: ["sonnet", "opus", "haiku"],
    local: true,
  },
];

export function isLocalProvider(id: AiProvider): boolean {
  return !!PROVIDERS.find((p) => p.id === id)?.local;
}

/** Detect local CLI agents installed on this machine. Desktop only. */
export async function localAgents(): Promise<LocalAgentInfo[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LocalAgentInfo[]>("ai_local_agents");
}

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model?: string;
}

const KEY = "jnt-ai-config";
const MAX_TOKENS = 8192;

export function getAiConfig(): AiConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as AiConfig;
    if (!c.provider) return null;
    // A local CLI agent authenticates itself — there is no key to store.
    return isLocalProvider(c.provider) || c.apiKey ? c : null;
  } catch { return null; }
}
export function setAiConfig(c: AiConfig): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}
export function clearAiConfig(): void {
  localStorage.removeItem(KEY);
}
export function hasAiKey(): boolean {
  return !!getAiConfig();
}

function metaFor(id: AiProvider): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

function providerError(body: string, status: number): string {
  try {
    const v = JSON.parse(body);
    const msg = v?.error?.message ?? v?.error ?? v?.message;
    if (typeof msg === "string") return msg;
  } catch { /* fall through */ }
  return `${status}`;
}

// Stream a prompt against the configured provider, browser-direct. Calls
// onToken with each text delta as it arrives and returns the full answer. All
// three providers stream over SSE (`data: {json}` lines); we dispatch on the
// payload shape. This is the feedback loop — the answer types itself in live.
export async function runAiStream(
  system: string,
  user: string,
  onToken: (delta: string) => void,
): Promise<string> {
  const cfg = getAiConfig();
  if (!cfg) throw new Error("No AI key set — add one in Settings.");
  const model = cfg.model?.trim() || metaFor(cfg.provider).defaultModel;

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extract: (d: any) => string | undefined;

  if (cfg.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    };
    body = { model, max_tokens: MAX_TOKENS, stream: true, system, messages: [{ role: "user", content: user }] };
    extract = (d) => (d?.type === "content_block_delta" && d.delta?.type === "text_delta" ? d.delta.text : undefined);
  } else if (cfg.provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers = { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" };
    body = { model, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    extract = (d) => d?.choices?.[0]?.delta?.content;
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    headers = { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" };
    body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    };
    extract = (d) => d?.candidates?.[0]?.content?.parts?.[0]?.text;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(providerError(t, res.status));
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { continue; }
      const tok = extract(parsed);
      if (tok) { full += tok; onToken(tok); }
    }
  }
  if (!full) throw new Error("The model returned no text.");
  return full;
}

// Run a single-shot prompt against the configured provider, browser-direct.
// Returns the model's plain-text answer. Throws with a readable message.
export async function runAiPrompt(system: string, user: string): Promise<string> {
  const cfg = getAiConfig();
  if (!cfg) throw new Error("No AI key set — add one in Settings.");
  const model = cfg.model?.trim() || metaFor(cfg.provider).defaultModel;

  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: user }] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(providerError(text, res.status));
    const v = JSON.parse(text);
    const block = (v.content as Array<{ type: string; text?: string }> | undefined)?.find((b) => b.type === "text");
    if (!block?.text) throw new Error("The model returned no text.");
    return block.text;
  }

  if (cfg.provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(providerError(text, res.status));
    const v = JSON.parse(text);
    const content = v.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content) throw new Error("The model returned no text.");
    return content;
  }

  // google
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: MAX_TOKENS },
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(providerError(text, res.status));
  const v = JSON.parse(text);
  const part = v.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof part !== "string" || !part) throw new Error("The model returned no text.");
  return part;
}
