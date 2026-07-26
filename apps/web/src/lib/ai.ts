// Bring-your-own-key AI for the web surface. The user supplies a provider key
// (Anthropic, OpenAI, or Google); calls go browser-direct, so the app never
// sees a token and there's nothing to meter. The desktop surface runs the local
// `claude` CLI instead (BYO-CLI-auth) — see src-tauri run_task. Mirrors justdb's
// provider dispatch; kept plain-text (no structured-output schema) since "ask"
// wants prose, not JSON.

export type AiProvider = "anthropic" | "openai" | "google";

export interface ProviderMeta {
  id: AiProvider;
  label: string;
  defaultModel: string;
  keyPlaceholder: string;
  models: string[];
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-4-8",
    keyPlaceholder: "sk-ant-...",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
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
];

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
    return c.apiKey && c.provider ? c : null;
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
