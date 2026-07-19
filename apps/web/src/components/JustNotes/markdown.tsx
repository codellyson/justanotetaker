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

// Only ever treat these schemes as links/images in note content. A note is
// user-authored, so an unguarded `[x](javascript:…)` would become a clickable
// href handed to window.open / the desktop OS opener, and an unguarded image
// src could point at a non-web scheme. Anything else renders as inert text.
const SAFE_HREF = /^(https?:|mailto:)/i;
const SAFE_IMG_SRC = /^(https?:|data:image\/)/i;

function Img({ src, alt }: { src: string; alt: string }) {
  if (!SAFE_IMG_SRC.test(src.trim())) return <>{alt || src}</>;
  return (
    <img
      className="md-img"
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
    />
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  if (!SAFE_HREF.test(href.trim())) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onClick={onLinkClick(href)}>
      {children}
    </a>
  );
}

// Inline tokens, matched in priority order: code, image, link, bold, strike,
// highlight, italic (* and _), bare URL, #tag. Order matters — code and the
// bracket forms are matched before the looser emphasis/url patterns.
const INLINE_SRC = [
  "`[^`\\n]+?`", // code
  "!\\[[^\\]\\n]*\\]\\([^)\\s]+\\)", // ![alt](url)
  "\\[[^\\]\\n]+?\\]\\([^)\\s]+\\)", // [text](url)
  "\\*\\*[^*\\n]+?\\*\\*", // **bold**
  "~~[^~\\n]+?~~", // ~~strike~~
  "==[^=\\n]+?==", // ==highlight==
  "\\*(?!\\s)[^*\\n]+?(?<!\\s)\\*", // *italic*
  "(?<![A-Za-z0-9])_[^_\\n]+?_(?![A-Za-z0-9])", // _italic_
  "https?:\\/\\/[^\\s)]+", // url
  "#[A-Za-z][A-Za-z0-9_-]*", // #tag
].join("|");

export function renderInlineMd(text: string, keyBase = "i"): React.ReactNode[] {
  // A fresh regex per call: renderInlineMd recurses for bold/italic/link
  // children, so a shared global's lastIndex would be clobbered mid-scan.
  const re = new RegExp(INLINE_SRC, "g");
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("![")) {
      const mm = tok.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (mm) out.push(<Img key={key} src={mm[2]} alt={mm[1]} />);
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (mm) out.push(<Link key={key} href={mm[2]}>{renderInlineMd(mm[1], key)}</Link>);
    } else if (tok.startsWith("**")) out.push(<strong key={key}>{renderInlineMd(tok.slice(2, -2), key)}</strong>);
    else if (tok.startsWith("~~")) out.push(<del key={key}>{renderInlineMd(tok.slice(2, -2), key)}</del>);
    else if (tok.startsWith("==")) out.push(<mark key={key} className="md-mark">{renderInlineMd(tok.slice(2, -2), key)}</mark>);
    else if (tok.startsWith("*")) out.push(<em key={key}>{renderInlineMd(tok.slice(1, -1), key)}</em>);
    else if (tok.startsWith("_")) out.push(<em key={key}>{renderInlineMd(tok.slice(1, -1), key)}</em>);
    else if (tok.startsWith("#")) out.push(<span key={key} className="md-tag" data-tag={tok.slice(1)}>{tok}</span>);
    else out.push(<Link key={key} href={tok}>{tok}</Link>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const IMG_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?\S*)?$/i;
const IMG_MD_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

// GFM table delimiter row, e.g. `|---|:--:|---:|`. The caller also requires a
// pipe so a bare `---` horizontal rule isn't mistaken for a delimiter.
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

// Split a table row into trimmed cells on unescaped pipes, dropping the
// optional leading/trailing pipe.
function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function renderHeadline(line: string): React.ReactNode[] {
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  return renderInlineMd(h ? h[2] : line, "h");
}

// onToggle(taskIndex) fires when the Nth task checkbox in this text is clicked
// (index across the whole rendered text). The caller rewrites that line.
export function renderBody(text: string, opts?: { onToggle?: (taskIndex: number) => void }): React.ReactNode[] {
  const onToggle = opts?.onToggle;
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let taskIdx = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
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

    // Blank line.
    if (!line.trim()) {
      out.push(<div key={i} className="md-blank" />);
      i++;
      continue;
    }

    // GFM table — a header row of pipes followed by a `---|:--:` delimiter row.
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_DELIM_RE.test(lines[i + 1])) {
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((d) => {
        const l = d.startsWith(":"), r = d.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : undefined;
      });
      const key = `tbl${i}`;
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} style={{ textAlign: aligns[hi] }}>{renderInlineMd(h, `${key}h${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] }}>{renderInlineMd(r[ci] ?? "", `${key}r${ri}c${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={i} className="md-hr" />);
      i++;
      continue;
    }

    // Standalone image — ![alt](url) or a bare image URL — rendered as a block.
    const imgMd = line.trim().match(IMG_MD_RE);
    if (imgMd) {
      out.push(<div key={i} className="md-img-wrap"><Img src={imgMd[2]} alt={imgMd[1]} /></div>);
      i++;
      continue;
    }
    if (IMG_URL_RE.test(line.trim())) {
      out.push(<div key={i} className="md-img-wrap"><Img src={line.trim()} alt="" /></div>);
      i++;
      continue;
    }

    // Heading (body h1–h3).
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length, 3);
      out.push(<div key={i} className={`md-h md-h${lvl}`}>{renderInlineMd(h[2], `h${i}`)}</div>);
      i++;
      continue;
    }

    // Blockquote — group consecutive `>` lines.
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote key={`q${i}`} className="md-quote">
          {quote.map((ql, qi) => <div key={qi}>{renderInlineMd(ql, `q${i}-${qi}`)}</div>)}
        </blockquote>,
      );
      continue;
    }

    // Task list item — checkbox toggled via onToggle. Checked before plain
    // bullets so `- [ ] x` isn't swallowed by the unordered-list rule.
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      const done = task[1].toLowerCase() === "x";
      const idx = taskIdx++;
      out.push(
        <div key={i} className={"md-li md-task" + (done ? " done" : "")}>
          <input
            type="checkbox"
            className="md-check"
            checked={done}
            onChange={() => onToggle?.(idx)}
            onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          />
          <span>{renderInlineMd(task[2], `t${i}`)}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Ordered list item.
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      out.push(
        <div key={i} className="md-li md-ol">
          <span className="md-num">{ol[1]}.</span>
          <span>{renderInlineMd(ol[2], `o${i}`)}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Unordered list item.
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      out.push(
        <div key={i} className="md-li">
          <span className="md-bullet" aria-hidden="true">·</span>
          <span>{renderInlineMd(li[1], `b${i}`)}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Paragraph.
    out.push(<div key={i} className="md-p">{renderInlineMd(line, `b${i}`)}</div>);
    i++;
  }
  return out;
}

// Flip the Nth task checkbox (`- [ ]` ⇄ `- [x]`) in a note's text. Returns the
// rewritten text, or the original if that task index isn't found.
export function toggleTaskLine(text: string, taskIndex: number): string {
  const lines = text.split("\n");
  let k = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-*]\s+\[)([ xX])(\]\s+.*)$/);
    if (!m) continue;
    if (k === taskIndex) {
      const next = m[2].toLowerCase() === "x" ? " " : "x";
      lines[i] = `${m[1]}${next}${m[3]}`;
      return lines.join("\n");
    }
    k++;
  }
  return text;
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
      <pre className="md-code md-code-fallback" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="md-code"
      onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
