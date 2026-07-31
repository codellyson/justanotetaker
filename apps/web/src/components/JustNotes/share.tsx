import { useEffect, useRef, useState } from "react";
import { TweaksPanel } from "./tweaks";
import { WEB_BASE_URL } from "../../lib/runtime";
import type { Board } from "./lib";

const SHARE_STYLE = `
  .shr-intro{color:rgb(var(--text-secondary));line-height:1.5}
  .shr-row{display:flex;align-items:center;gap:8px;padding:8px 10px;
    border-radius:9px;background:rgb(var(--bg) / .4);border:.5px solid rgb(var(--border) / .5)}
  .shr-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .shr-row-name{font-weight:600;color:rgb(var(--text-primary))}
  .shr-row-meta{color:rgb(var(--text-secondary));font-size:10px}
  .shr-btn{appearance:none;font:inherit;font-weight:600;white-space:nowrap;cursor:default;
    border:0;border-radius:7px;padding:6px 11px;
    background:rgb(var(--accent));color:rgb(var(--accent-contrast, 255 255 255))}
  .shr-btn.shr-ghost{background:rgb(var(--bg) / .5);color:rgb(var(--text-primary));
    border:.5px solid rgb(var(--border) / .7);font-weight:500}
  .shr-btn.shr-ghost:hover{background:rgb(var(--accent) / .14)}
  .shr-code{display:flex;flex-direction:column;gap:6px}
  .shr-code code{display:block;font-family:ui-monospace,monospace;font-size:10px;
    background:rgb(var(--bg) / .6);color:rgb(var(--text-primary));
    border:.5px solid rgb(var(--border) / .7);border-radius:6px;padding:6px 8px;
    overflow-x:auto;white-space:nowrap;user-select:all;
    scrollbar-width:thin;scrollbar-color:rgb(var(--border) / .7) transparent}
  .shr-warn{color:rgb(var(--text-secondary));font-size:10px;line-height:1.5}
`;

export function SharePanel({
  open,
  onClose,
  board,
  onSetVisibility,
}: {
  open: boolean;
  onClose: () => void;
  board: Board | null;
  onSetVisibility: (id: string, visibility: Board["visibility"]) => void;
}) {
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  if (!board) return null;
  const isPublic = board.visibility === "public";
  const shareUrl = `${WEB_BASE_URL}/b/${board.id}`;
  const embedCode = `<iframe src="${shareUrl}?embed=1" width="100%" height="600" style="border:0"></iframe>`;

  async function copy(kind: "link" | "embed", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // clipboard blocked — fields are user-select:all
    }
  }

  return (
    <TweaksPanel open={open} onClose={onClose} title="Share board">
      <style>{SHARE_STYLE}</style>

      <div className="shr-row">
        <div className="shr-row-main">
          <div className="shr-row-name">{board.name}</div>
          <div className="shr-row-meta">
            {isPublic ? "Public — anyone with the link can view" : "Private — only you can see this board"}
          </div>
        </div>
        <button
          className={"shr-btn" + (isPublic ? " shr-ghost" : "")}
          onClick={() => onSetVisibility(board.id, isPublic ? "private" : "public")}
        >
          {isPublic ? "Make private" : "Make public"}
        </button>
      </div>

      {isPublic && (
        <>
          <div className="twk-sect">Share link</div>
          <div className="shr-code">
            <code>{shareUrl}</code>
            <button className="shr-btn shr-ghost" onClick={() => void copy("link", shareUrl)}>
              {copied === "link" ? "Copied" : "Copy link"}
            </button>
          </div>

          <div className="twk-sect">Embed</div>
          <div className="shr-code">
            <code>{embedCode}</code>
            <button className="shr-btn shr-ghost" onClick={() => void copy("embed", embedCode)}>
              {copied === "embed" ? "Copied" : "Copy embed code"}
            </button>
          </div>

          <div className="shr-warn">
            Everything on this board is visible to anyone with the link — note text,
            images, and files. Making it private again revokes the link, but media
            already downloaded stays downloaded.
          </div>
        </>
      )}
    </TweaksPanel>
  );
}
