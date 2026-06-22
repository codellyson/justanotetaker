import React, { useEffect, useState } from "react";
import { useTheme } from "@codellyson/justui/react";
import { openInSystemBrowser } from "../../lib/tauri-oauth";
import { getHighlighter, isSupportedLang, normalizeLang } from "../../lib/highlighter";

function onLinkClick(href: string) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    void openInSystemBrowser(href);
  };
}

export function renderInlineMd(text: string, keyBase = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|https?:\/\/[^\s)]+|#[A-Za-z][A-Za-z0-9_-]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("#"))
      out.push(
        <span key={key} className="md-tag" data-tag={tok.slice(1)}>
          {tok}
        </span>,
      );
    else
      out.push(
        <a
          key={key}
          href={tok}
          target="_blank"
          rel="noreferrer"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onLinkClick(tok)}
        >
          {tok}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderHeadline(line: string): React.ReactNode[] {
  return renderInlineMd(line.replace(/^#+\s*/, ""), "h");
}

export function renderBody(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*`{3,}\s*(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "text";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*`{3,}\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(<CodeBlock key={`c${i}`} code={body.join("\n")} lang={lang} />);
      continue;
    }
    if (!line.trim()) {
      out.push(<div key={i} className="md-blank" />);
      i++;
      continue;
    }
    const liMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (liMatch) {
      out.push(
        <div key={i} className="md-li">
          <span className="md-bullet" aria-hidden="true">·</span>
          <span>{renderInlineMd(liMatch[2], `b${i}`)}</span>
        </div>,
      );
    } else {
      out.push(<div key={i} className="md-p">{renderInlineMd(line, `b${i}`)}</div>);
    }
    i++;
  }
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { mode } = useTheme();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const useLang = isSupportedLang(lang) ? normalizeLang(lang) : "text";
    const theme = mode === "dark" ? "github-dark" : "github-light";
    void getHighlighter().then((h) => {
      if (cancelled) return;
      try {
        const out = h.codeToHtml(code, { lang: useLang, theme });
        if (!cancelled) setHtml(out);
      } catch (err) {
        console.warn("[shiki] highlight failed", err);
      }
    });
    return () => { cancelled = true; };
  }, [code, lang, mode]);

  if (!html) {
    return (
      <pre className="md-code md-code-fallback" onMouseDown={(e) => e.stopPropagation()}>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="md-code"
      onMouseDown={(e) => e.stopPropagation()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
