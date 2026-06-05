import React from "react";

// inline: **bold**, `code`, bare http(s) URLs.
export function renderInlineMd(text: string, keyBase = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else
      out.push(
        <a
          key={key}
          href={tok}
          target="_blank"
          rel="noreferrer"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
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
  return lines.map((line, i) => {
    if (!line.trim()) return <div key={i} className="md-blank" />;
    const liMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (liMatch) {
      return (
        <div key={i} className="md-li">
          <span className="md-bullet" aria-hidden="true">·</span>
          <span>{renderInlineMd(liMatch[2], `b${i}`)}</span>
        </div>
      );
    }
    return <div key={i} className="md-p">{renderInlineMd(line, `b${i}`)}</div>;
  });
}
