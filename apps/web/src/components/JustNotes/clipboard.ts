import { parsePastedUrl } from "./lib";

// Identify what kind of thing a copied string is, so a captured clipboard
// note can be rendered/handled appropriately without the user filing it.
// Detection is heuristic, synchronous, dependency-free — good enough to pick
// the right treatment, not a parser. Order matters: most specific first.
export type ClipboardKind = "url" | "email" | "json" | "code" | "markdown" | "text";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function classifyClipboardText(raw: string): ClipboardKind {
  const text = raw.trim();
  if (!text) return "text";

  // URL — reuse the existing single-token detector (http(s):// or bare domain).
  if (parsePastedUrl(text)) return "url";

  // Email — a lone address, no surrounding prose.
  if (!/\s/.test(text) && EMAIL_RE.test(text)) return "email";

  // JSON — starts structured and round-trips through the parser.
  if (/^[[{]/.test(text) && isJsonObject(text)) return "json";

  // Code before Markdown: a raw snippet shouldn't read as prose, but a doc
  // that merely contains a fenced block should still count as markdown.
  if (looksLikeCode(text)) return "code";
  if (looksLikeMarkdown(text)) return "markdown";

  return "text";
}

function isJsonObject(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

function looksLikeCode(text: string): boolean {
  if (/^```/.test(text)) return true;
  const lines = text.split("\n");
  let score = 0;
  if (/\b(function|const|let|var|return|import|export|class|def|fn|func|public|private|void|interface|struct|package|namespace|async|await)\b/.test(text)) score++;
  if (/=>|::|->|;\s*$|\{\s*$|\}\s*$/m.test(text)) score++;
  if (lines.length > 1 && /^[ \t]+\S/m.test(text)) score++; // consistent indentation
  if ((text.match(/[{}();]/g)?.length ?? 0) >= 3) score++;
  if (/^\s*(#include|using\s|from\s.+\simport\s|package\s|#!\/)/m.test(text)) score++;
  // Shell prompts — only `$ ` (avoids colliding with Markdown `#`/`>`); a
  // multi-line session is a strong enough signal to count as code on its own.
  const shellPrompts = (text.match(/^\s*\$ /gm) ?? []).length;
  if (shellPrompts >= 1) score++;
  if (shellPrompts >= 2) score++;
  return score >= 2;
}

function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) || // headings
    /^\s*[-*+]\s+\S/m.test(text) || // bullet list
    /^\s*\d+\.\s+\S/m.test(text) || // ordered list
    /\[[^\]]+\]\([^)]+\)/.test(text) || // inline link
    /(\*\*|__)[^*_]+(\*\*|__)/.test(text) || // bold
    /^>\s+\S/m.test(text) || // blockquote
    /```/.test(text) // fenced block
  );
}

// Turn a classified clipboard string into the text a captured note should
// carry. Code/JSON get fenced so the existing markdown+shiki renderer
// highlights them; everything else is stored verbatim (URLs keep their
// paste→preview behavior, markdown renders as-is).
export function formatCapturedNote(raw: string): { text: string; kind: ClipboardKind } {
  const kind = classifyClipboardText(raw);
  const text = raw.trim();
  switch (kind) {
    case "code":
      return { text: text.startsWith("```") ? text : "```\n" + text + "\n```", kind };
    case "json":
      return { text: "```json\n" + prettyJson(text) + "\n```", kind };
    default:
      return { text, kind };
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
