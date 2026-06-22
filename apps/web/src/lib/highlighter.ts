import type { HighlighterCore } from "shiki/core";

const SUPPORTED = new Set([
  "javascript", "js", "typescript", "ts", "tsx", "jsx",
  "python", "py", "go", "rust", "rs", "sql",
  "json", "shell", "sh", "bash", "css", "html", "markdown", "md",
]);

let promise: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!promise) {
    promise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      return createHighlighterCore({
        themes: [
          import("@shikijs/themes/github-light"),
          import("@shikijs/themes/github-dark"),
        ],
        langs: [
          import("@shikijs/langs/javascript"),
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/tsx"),
          import("@shikijs/langs/jsx"),
          import("@shikijs/langs/python"),
          import("@shikijs/langs/go"),
          import("@shikijs/langs/rust"),
          import("@shikijs/langs/sql"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/shellscript"),
          import("@shikijs/langs/css"),
          import("@shikijs/langs/html"),
          import("@shikijs/langs/markdown"),
        ],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return promise;
}

export function normalizeLang(lang: string): string {
  const l = lang.toLowerCase();
  if (l === "js") return "javascript";
  if (l === "ts") return "typescript";
  if (l === "py") return "python";
  if (l === "rs") return "rust";
  if (l === "md") return "markdown";
  if (l === "sh" || l === "bash") return "shellscript";
  if (l === "shell") return "shellscript";
  return l;
}

export function isSupportedLang(lang: string): boolean {
  return SUPPORTED.has(lang.toLowerCase());
}
